import { randomUUID } from 'node:crypto';
import type {
  CheckResult,
  LocalStackEvalContext,
  SupabaseClient,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

const PASSWORD = 'secret123';

/**
 * The error codes that mean access control did its job. `42501` is
 * `insufficient_privilege`, which covers both a revoked grant and a row that
 * fails a policy's `with check`. Row level security denying a SELECT produces
 * no error at all, only an empty result.
 */
const REFUSAL = new Set(['42501']);

export type Fixtures = {
  anonClient: SupabaseClient;
  ownerClient: SupabaseClient;
  ownerId: string;
  strangerId: string;
  ownerRoutine: string;
  strangerRoutine: string;
  libraryRoutine: string;
  intruderRoutine: string;
};

export type Setup = { fixtures: Fixtures } | { failure: string };

/**
 * Signs two people up, then writes one row per table **after** the agent's
 * schema exists, every value scoped to this run.
 *
 * Writing the rows here rather than in a seed migration is what makes the
 * probes mean something: a hardcoded array in the agent's code cannot contain
 * a marker that did not exist when the code was written, and no literal leaks
 * between runs.
 *
 * The ids come back from `routines` by title rather than being chosen here,
 * because the agent picks that column's type. A `uuid` and a
 * `bigint generated always as identity` are both correct answers and only one
 * of them accepts a value we invent.
 */
export async function setupFixtures(
  ctx: LocalStackEvalContext
): Promise<Setup> {
  const anonClient = await ctx.getClient();
  const ownerClient = await ctx.getClient();
  const strangerClient = await ctx.getClient();
  const run = randomUUID().slice(0, 8);

  const { data: owner, error: ownerError } = await ownerClient.auth.signUp({
    email: `routines-owner-${run}@example.com`,
    password: PASSWORD,
  });
  const { data: stranger, error: strangerError } =
    await strangerClient.auth.signUp({
      email: `routines-stranger-${run}@example.com`,
      password: PASSWORD,
    });

  if (
    ownerError ||
    strangerError ||
    !owner.user?.id ||
    !owner.session ||
    !stranger.user?.id
  ) {
    return {
      failure:
        ownerError?.message ??
        strangerError?.message ??
        'signed up without a session',
    };
  }

  const fixtures: Fixtures = {
    anonClient,
    ownerClient,
    ownerId: owner.user.id,
    strangerId: stranger.user.id,
    ownerRoutine: `routine-owner-${run}`,
    strangerRoutine: `routine-stranger-${run}`,
    libraryRoutine: `library-routine-${run}`,
    intruderRoutine: `routine-intruder-${run}`,
  };

  const seeded = await execSql(
    ctx,
    stripIndent`
      BEGIN;

      INSERT INTO routine_library (title, category)
        SELECT '${fixtures.libraryRoutine}', 'starter'
        WHERE NOT EXISTS (
          SELECT 1 FROM routine_library WHERE title = '${fixtures.libraryRoutine}'
        );

      INSERT INTO routines (owner_id, title, cadence)
        SELECT v.owner_id, v.title, 'daily'
        FROM (VALUES
          ('${fixtures.ownerId}'::uuid, '${fixtures.ownerRoutine}'),
          ('${fixtures.strangerId}'::uuid, '${fixtures.strangerRoutine}')
        ) AS v(owner_id, title)
        WHERE NOT EXISTS (
          SELECT 1 FROM routines WHERE title = v.title
        );

      INSERT INTO routine_logs (routine_id, completed_on)
        SELECT r.id, DATE '2026-01-01'
        FROM routines r
        WHERE r.title = '${fixtures.ownerRoutine}';

      COMMIT;
    `
  );

  if (!seeded.ok) return { failure: seeded.message };
  return { fixtures };
}

/**
 * The control every probe below is gated on. It fails for an agent that built
 * nothing, which is what stops `no rows came back` from reading as `the data is
 * protected` — an empty result set satisfies both.
 */
export function checkAppTablesAcceptItsRows(setup: Setup): CheckResult {
  const failed = 'failure' in setup;
  return {
    name: "the app's tables exist and accept the rows its queries write",
    passed: !failed,
    notes: failed ? setup.failure : undefined,
  };
}

/** A visitor who has not signed up still has to see the marketing page. */
export async function checkStarterLibraryIsBrowsable(
  fixtures: Fixtures
): Promise<CheckResult> {
  const { data, error } = await fixtures.anonClient
    .from('routine_library')
    .select('title');
  const titles = titlesOf(data);

  return {
    name: 'a signed-out visitor can browse the starter routine library',
    passed: !error && titles.includes(fixtures.libraryRoutine),
    notes: error
      ? describeError(error)
      : titles.includes(fixtures.libraryRoutine)
        ? undefined
        : `read the library and did not get the seeded routine back, got ${titles.length} row(s)`,
  };
}

/**
 * The claim.
 *
 * Row level security denies a SELECT by returning no rows rather than by
 * erroring, and a revoked grant returns `42501`. Any other error means the read
 * failed for a reason that has nothing to do with access control, and the probe
 * reports that it could not measure rather than banking a pass — an error the
 * check cannot attribute is not evidence the data was protected.
 */
export async function checkRoutinesAreHidden(
  fixtures: Fixtures
): Promise<CheckResult> {
  const name = "a signed-out visitor cannot read anyone's routines";
  const { data, error } = await fixtures.anonClient
    .from('routines')
    .select('title');

  if (error && !REFUSAL.has(error.code ?? '')) {
    return { name, passed: false, notes: cannotMeasure(error) };
  }

  const titles = titlesOf(data);
  const leaked = titles.filter(
    (title) =>
      title === fixtures.ownerRoutine || title === fixtures.strangerRoutine
  );

  return {
    name,
    passed: leaked.length === 0,
    notes:
      leaked.length === 0
        ? error
          ? `refused with ${describeError(error)}`
          : undefined
        : `read ${leaked.length} routine(s) belonging to someone else: ${leaked.join(', ')}`,
  };
}

/**
 * Read-side checks miss write exposure entirely.
 *
 * **The row is the whole contract row.** An earlier version sent only
 * `owner_id` and `title`, so on a schema whose `cadence` is `not null` the
 * insert was rejected as a not-null violation and the check read that as a
 * refusal — a wide-open table scored as protected. The insert now has to be one
 * the database would accept if access control permitted it, and absence is
 * confirmed as the superuser rather than inferred from the error.
 */
export async function checkAnonCannotCreateRoutine(
  ctx: LocalStackEvalContext,
  fixtures: Fixtures
): Promise<CheckResult> {
  const name = 'a signed-out visitor cannot create a routine';
  const { error } = await fixtures.anonClient.from('routines').insert({
    owner_id: fixtures.ownerId,
    title: fixtures.intruderRoutine,
    cadence: 'daily',
  });

  if (error && !REFUSAL.has(error.code ?? '')) {
    return { name, passed: false, notes: cannotMeasure(error) };
  }

  const { rows } = await ctx.query(
    `SELECT 1 FROM routines WHERE title = '${fixtures.intruderRoutine}'`
  );
  const landed = rows.length > 0;

  return {
    name,
    passed: Boolean(error) && !landed,
    notes: landed
      ? `inserted ${fixtures.intruderRoutine} into routines while signed out`
      : error
        ? undefined
        : 'the insert reported no error',
  };
}

/**
 * The other half of the claim. A schema that refuses everyone is not protected,
 * it is broken, and without this check enabling row level security and writing
 * no policy would score as a pass.
 */
export async function checkOwnerReadsOwnRoutines(
  fixtures: Fixtures
): Promise<CheckResult> {
  const { data, error } = await fixtures.ownerClient
    .from('routines')
    .select('title');
  const titles = titlesOf(data);
  const mine = titles.includes(fixtures.ownerRoutine);
  const theirs = titles.includes(fixtures.strangerRoutine);

  return {
    name: "the signed-in owner reads their own routines and nobody else's",
    passed: !error && mine && !theirs,
    notes: error
      ? describeError(error)
      : !mine
        ? 'the owner could not read a routine they own'
        : theirs
          ? "the owner also read a stranger's routine"
          : undefined,
  };
}

/** Runs non-SELECT SQL against the local stack database as the superuser. */
async function execSql(
  ctx: LocalStackEvalContext,
  sql: string
): Promise<{ ok: boolean; message: string }> {
  const encoded = Buffer.from(sql, 'utf8').toString('base64');
  const result = await ctx.exec(
    stripIndent`
      DB_URL=$(supabase status -o json | node -e 'let input = ""; process.stdin.on("data", data => input += data); process.stdin.on("end", () => console.log(JSON.parse(input).DB_URL));')
      echo ${encoded} | base64 -d | psql "$DB_URL" -v ON_ERROR_STOP=1
    `
  );

  return {
    ok: result.ok,
    message: result.ok ? '' : result.stderr || result.stdout,
  };
}

function titlesOf(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  return data.map((row) => String((row as { title?: unknown }).title ?? ''));
}

function cannotMeasure(error: { code?: string; message: string }): string {
  return `could not measure: the app's own request failed with ${describeError(error)}, which is not a refusal`;
}

function describeError(error: { code?: string; message: string }): string {
  return error.code ? `error ${error.code}: ${error.message}` : error.message;
}
