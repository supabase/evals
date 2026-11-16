import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';
import {
  applyPendingMigrations,
  checkMigrationsWereApplied,
} from './migrations.js';
import {
  checkClosedTeamRowsGone,
  checkInvoicesKept,
  checkLeaverCommentsKept,
  checkOtherTeamUntouched,
  checkTeamDeleteSucceeds,
  deleteClosedTeam,
  type Query,
  type Run,
  setupWorld,
} from './probes.js';

const GUIDE_PATH = 'guides/database/postgres/cascade-deletes';

const NAMES = [
  'deleting a member who left keeps the comments they wrote',
  'deleting a team succeeds',
  "the closed team's members, projects, tasks and comments are gone",
  "the closed team's invoices are kept",
  "the other team's rows are all still there",
];

const scorer: LocalStackScorer = async (ctx) => {
  try {
    // Apply first: correct SQL in an unapplied migration would otherwise red
    // every probe below. Applying costs the agent one check, not six.
    const migrations = await applyPendingMigrations(ctx);
    const query: Query = (sql) => ctx.query(sql);
    const run: Run = (sql) => execSql(ctx, sql);

    // The world is built after the agent's schema exists, with run-scoped
    // names, so nothing can be satisfied by rows the agent wrote.
    const setup = await setupWorld(run);

    // Order matters. The leaver is deleted first, because the team delete
    // then has to clear a comment whose author is already gone as well as
    // one whose author is still there. The team delete runs once, and the
    // three checks after it read what it left.
    let probes: CheckResult[];
    if ('failure' in setup) {
      probes = NAMES.map((name) => ({
        name,
        passed: false,
        notes: `not run: ${setup.failure}`,
      }));
    } else {
      const { world } = setup;
      const leaver = await guard(NAMES[0], () =>
        checkLeaverCommentsKept(query, run, world)
      );
      const deleted = await deleteClosedTeam(run, world);
      probes = [
        leaver,
        checkTeamDeleteSucceeds(deleted),
        await guard(NAMES[2], () =>
          checkClosedTeamRowsGone(query, world, deleted)
        ),
        await guard(NAMES[3], () => checkInvoicesKept(query, world, deleted)),
        await guard(NAMES[4], () =>
          checkOtherTeamUntouched(query, world, deleted)
        ),
      ];
    }

    const checks: CheckResult[] = [
      checkMigrationsWereApplied(migrations),
      ...probes,
      // Last: it reads the transcript, not the database.
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated what deleting a team removes',
          passed: false,
          notes: message,
        },
      ],
    };
  }
};

export default scorer;

// Writes go through psql because `ctx.query` wraps every statement in a
// SELECT subquery, which rejects DELETE and data-modifying WITH. Same route
// as build-docs-002's execSql. The Postgres error leads the message, ahead of
// any CLI chatter, so a blocked delete reads as one.
async function execSql(
  ctx: LocalStackEvalContext,
  sql: string
): Promise<{ ok: boolean; message: string }> {
  const encoded = Buffer.from(sql, 'utf8').toString('base64');
  const result = await ctx.exec(
    stripIndent`
      DB_URL=$(supabase status -o json 2>/dev/null | node -e 'let input = ""; process.stdin.on("data", data => input += data); process.stdin.on("end", () => console.log(JSON.parse(input).DB_URL));')
      echo ${encoded} | base64 -d | psql "$DB_URL" -v ON_ERROR_STOP=1 -q
    `
  );
  if (result.ok) return { ok: true, message: '' };
  const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  const lines = output.split('\n').map((line) => line.trim());
  const named = lines.filter((line) => /^(ERROR|DETAIL)\b/.test(line));
  return {
    ok: false,
    message: (named.length > 0 ? named.join(' ') : output.trim()).slice(0, 300),
  };
}

// A query that throws (a table the agent renamed, say) costs one check, not
// the whole result.
async function guard(
  name: string,
  run: () => Promise<CheckResult>
): Promise<CheckResult> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: message.slice(0, 300) };
  }
}

function checkGuideWasRead(ctx: LocalStackEvalContext): CheckResult {
  const calls = buildDocsResult(ctx.toolCalls).calls.filter((call) =>
    call.pages?.some((page) => page.url.includes(GUIDE_PATH))
  );
  const withContent = calls.filter((call) => call.hasContent);
  return {
    name: 'the agent read the cascade deletes guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
