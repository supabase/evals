import type {
  CheckResult,
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import {
  describeFailure,
  errorMessage,
  inProjectDir,
  shellQuote,
  truncate,
} from '../lib/shell.js';
import type { StackProbe } from '../lib/stack.js';
import { NOTES_TABLE, SEEDED_NOTES_POLICIES, TESTS_DIR } from './fixtures.js';
import { compareText, psqlCommand } from './psql.js';
import {
  DROP_NOTES_POLICIES_SQL,
  readNotesSnapshot,
  restoreNotesAccess,
  sameSnapshot,
  type NotesAccessSnapshot,
} from './snapshot.js';

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;

export type TapEntry = {
  ok: boolean;
  number: number | null;
  description: string;
  todo: boolean;
  skip?: true;
};
export type TapResult = {
  planned: number | null;
  plans: number;
  results: TapEntry[];
};
export type TestFileRun = {
  file: string;
  passed: boolean;
  exitCode: number | null;
  tap: TapResult;
  detail: string;
  stoppedAt?: string;
};
export type MutatedRun = TestFileRun & { mutationApplied: boolean };
export type CatchRun = {
  file: string;
  mutated: MutatedRun;
  ownerOnly: MutatedRun | null;
  openReads: MutatedRun | null;
  leaked?: boolean;
  restoreFailure?: string;
};
export type Twin = 'owner-only' | 'open-reads';
export type FlippedTest = {
  number: number;
  description: string;
  ranUnderOpenReads: boolean;
  openReadsOnly?: true;
  stoppedAt?: string;
};
export type TwinDifference =
  | { number: number; description: string }
  | { wholeFile: true };
export type NotCaughtReason =
  | 'unrestored'
  | 'leak-not-applied'
  | 'leak-passed'
  | 'twins-not-applied'
  | 'same-under-twins'
  | 'leak-failed-elsewhere';
export type CatchVerdict =
  | { caught: true; test: FlippedTest }
  | {
      caught: true;
      passedOutright: true;
      failedPlan?: true;
      exited?: { stoppedAt?: string };
    }
  | {
      caught: false;
      reason: Exclude<NotCaughtReason, 'leak-failed-elsewhere'>;
      twins?: Twin[];
    }
  | {
      caught: false;
      reason: 'leak-failed-elsewhere';
      changed: TwinDifference;
    };
export type TestFilesProbe =
  | { ok: true; files: string[] }
  | { ok: false; notes: string };
export type SuiteProbe =
  | {
      ok: true;
      files: string[];
      clean: TestFileRun[];
      catches: CatchRun[];
      mutationBlocked?: string;
      unmutated?: string[];
    }
  | { ok: false; notes: string };

export const TESTS_PASS_CHECK_NAME =
  "the project's pgTAP tests pass against the local database";
export const TESTS_CATCH_CHECK_NAME =
  'the tests fail when the seeded notes policies are put back';
export const MUTATION_MARKER = 'eval-mutation-applied';
export const OWNER_ONLY_TWIN_MARKER = 'eval-twin-owner-only-applied';
export const OPEN_READS_TWIN_MARKER = 'eval-twin-open-reads-applied';

const PROBE_FUNCTION = 'public.eval_probe_can_read_note';
export const DROP_PROBE_FUNCTION_SQL = `drop function if exists ${PROBE_FUNCTION}(uuid)`;

/** The same four policies in both twins, so a test that reads the catalog cannot tell them apart; only the probe function's body decides who can read notes. */
export const TWIN_NOTES_POLICIES: readonly string[] = [
  `create policy "eval-probe read" on public.${NOTES_TABLE} for select to authenticated using (${PROBE_FUNCTION}(owner_id))`,
  `create policy "eval-probe insert" on public.${NOTES_TABLE} for insert to authenticated with check ((select auth.uid()) = owner_id)`,
  `create policy "eval-probe update" on public.${NOTES_TABLE} for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id)`,
  `create policy "eval-probe delete" on public.${NOTES_TABLE} for delete to authenticated using ((select auth.uid()) = owner_id)`,
];

const PLAN_RE = /^1\.\.(\d+)(?:\s+#.*)?$/;
const RESULT_RE = /^(not )?ok\b(?:\s+(\d+))?\s*(?:-\s*)?(.*)$/;
const DIRECTIVE_RE = /(?:^|\s+)#\s*(todo|skip)\b.*$/i;
const STOPPED_AT_RE = /^psql:(.+?):(\d+): ERROR:/m;
const NO_SUCH_DIRECTORY_RE = /No such file or directory/i;
const TEST_FILE_RE = /\.(?:sql|pg)$/;

/** Reads the TAP lines of a pgTAP run the way `pg_prove` does: plan lines, `ok`/`not ok` results and their TODO and SKIP directives. */
export function parseTap(output: string): TapResult {
  let planned: number | null = null;
  let plans = 0;
  const results: TapEntry[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.trimEnd();
    const plan = PLAN_RE.exec(line);
    if (plan !== null) {
      planned = Number(plan[1]);
      plans++;
      continue;
    }
    const result = RESULT_RE.exec(line);
    if (result === null) continue;
    const directive = DIRECTIVE_RE.exec(result[3])?.[1].toLowerCase();
    results.push({
      ok: result[1] === undefined,
      number: result[2] === undefined ? null : Number(result[2]),
      description: result[3].replace(DIRECTIVE_RE, '').trim(),
      todo: directive === 'todo',
      ...(directive === 'skip' ? { skip: true } : {}),
    });
  }
  return { planned, plans, results };
}

/** Whether a pgTAP file passed: psql exited 0, there is one plan, every planned test ran, and none failed outside a TODO. */
export function tapPassed(exitCode: number | null, tap: TapResult): boolean {
  return (
    exitCode === 0 &&
    tap.plans === 1 &&
    tap.planned === tap.results.length &&
    tap.results.every((entry) => entry.ok || entry.todo)
  );
}

/** Lists the pgTAP test files under `supabase/tests`, sorted; a missing directory holds none. */
export async function listTestFiles(ctx: ExecContext): Promise<TestFilesProbe> {
  try {
    const result = await ctx.exec(
      `find ${TESTS_DIR} -type f \\( -name '*.sql' -o -name '*.pg' \\)`
    );
    if (!result.ok) {
      return NO_SUCH_DIRECTORY_RE.test(result.stderr)
        ? { ok: true, files: [] }
        : {
            ok: false,
            notes: `could not list ${TESTS_DIR}: ${describeFailure(result)}`,
          };
    }
    const files = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => TEST_FILE_RE.test(line))
      .sort(compareText);
    return { ok: true, files };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

const buildPolicySwapSql = (
  policies: readonly string[],
  marker: string,
  setup: readonly string[] = []
) =>
  `begin;
${DROP_NOTES_POLICIES_SQL}
alter table public.${NOTES_TABLE} enable row level security;
${[...setup, ...policies].map((statement) => `${statement};`).join('\n')}
select '${marker}';
`;

/** SQL that opens a transaction and leaves it open with the seeded notes policies back in place, ending with the marker that proves it ran. */
export const buildMutationSql = () =>
  buildPolicySwapSql(SEEDED_NOTES_POLICIES, MUTATION_MARKER);

const buildTwinSql = (body: string, marker: string) =>
  buildPolicySwapSql(TWIN_NOTES_POLICIES, marker, [
    `create or replace function ${PROBE_FUNCTION}(note_owner uuid) returns boolean language sql stable as $$${body}$$`,
    `grant execute on function ${PROBE_FUNCTION}(uuid) to anon, authenticated`,
  ]);

/** The twin whose probe function lets a signed-in user read only their own notes, like the fixed database. */
export const buildOwnerOnlyTwinSql = () =>
  buildTwinSql(
    'select (select auth.uid()) = note_owner',
    OWNER_ONLY_TWIN_MARKER
  );

/** The twin whose probe function lets every signed-in user read every note, like the seeded leak. */
export const buildOpenReadsTwinSql = () =>
  buildTwinSql('select true', OPEN_READS_TWIN_MARKER);

/** Runs `fn` with pgTAP installed, creating the extension first and dropping it afterwards when the project did not already have it. */
export async function withPgtap<T>(
  ctx: ExecContext,
  dbUrl: string,
  fn: () => Promise<T>
): Promise<T | { ok: false; notes: string }> {
  const probe = await ctx.exec(
    psqlCommand(dbUrl, [
      `-c "select count(*) from pg_extension where extname = 'pgtap'"`,
    ])
  );
  if (!probe.ok) {
    return {
      ok: false,
      notes: `could not check for pgTAP: ${describeFailure(probe)}`,
    };
  }
  const installed = probe.stdout.trim();
  if (installed !== '0' && installed !== '1') {
    return {
      ok: false,
      notes: `unrecognised pgTAP extension probe output: ${truncate(installed, 120)}`,
    };
  }
  if (installed === '1') return fn();

  const created = await ctx.exec(
    psqlCommand(dbUrl, [
      '-c "create extension if not exists pgtap with schema extensions"',
    ])
  );
  if (!created.ok) {
    return {
      ok: false,
      notes: `could not install pgTAP: ${describeFailure(created)}`,
    };
  }
  try {
    return await fn();
  } finally {
    await ctx
      .exec(psqlCommand(dbUrl, ['-c "drop extension if exists pgtap"']))
      .catch(() => undefined);
  }
}

/** `planned 3, ran 1`, with the plan-line count when a file printed more than one. */
export function describeTapCounts(tap: TapResult): string {
  const plan =
    tap.planned === null
      ? 'no plan'
      : `planned ${tap.planned}${tap.plans > 1 ? ` (${tap.plans} plan lines)` : ''}`;
  return `${plan}, ran ${tap.results.length}`;
}

function describeExit(result: CommandResult): string {
  const stderr = result.stderr.trim();
  const exit = `psql exit ${result.exitCode ?? 'none'}`;
  return stderr === '' ? exit : `${exit}: ${truncate(stderr, 200)}`;
}

/** `stdout` without the lines that are exactly `marker`. */
export const withMarkerRemoved = (stdout: string, marker: string) =>
  stdout
    .split('\n')
    .filter((line) => line.trim() !== marker)
    .join('\n');

function toRun(file: string, result: CommandResult): TestFileRun {
  const tap = parseTap(result.stdout);
  const stop = STOPPED_AT_RE.exec(result.stderr);
  return {
    file,
    passed: tapPassed(result.exitCode, tap),
    exitCode: result.exitCode,
    tap,
    detail: describeExit(result),
    ...(stop === null ? {} : { stoppedAt: `${stop[1]}:${stop[2]}` }),
  };
}

const TESTS_PREFIX = `${TESTS_DIR}/`;

/** Runs psql from `supabase/tests` over a path relative to it, as `supabase test db` runs pg_prove; `script` wraps the file in a rolled-back transaction. */
function execTestFile(
  ctx: ExecContext,
  dbUrl: string,
  file: string,
  script?: string
): Promise<CommandResult> {
  const relative = file.startsWith(TESTS_PREFIX)
    ? file.slice(TESTS_PREFIX.length)
    : file;
  const target = `-f ${shellQuote(relative)}`;
  const psql =
    script === undefined
      ? psqlCommand(dbUrl, [target])
      : psqlCommand(dbUrl, ['-f -', target, '-c rollback'], script);
  return ctx.exec(inProjectDir(TESTS_DIR, psql));
}

const printedMarker = (result: CommandResult, marker: string) =>
  result.stdout.split('\n').some((line) => line.trim() === marker);

const runFile = async (ctx: ExecContext, dbUrl: string, file: string) =>
  toRun(file, await execTestFile(ctx, dbUrl, file));

async function runMutated(
  ctx: ExecContext,
  dbUrl: string,
  file: string,
  script: string,
  marker: string
): Promise<MutatedRun> {
  const result = await execTestFile(ctx, dbUrl, file, script);
  return {
    ...toRun(file, {
      ...result,
      stdout: withMarkerRemoved(result.stdout, marker),
    }),
    mutationApplied: printedMarker(result, marker),
  };
}

/** Compares the notes policies with `baseline` after a mutated run, restoring them when the file's own commit kept the mutation. */
async function settleNotesAccess(
  ctx: ExecContext,
  dbUrl: string,
  baseline: NotesAccessSnapshot
): Promise<{ leaked: boolean; failure?: string }> {
  const after = await readNotesSnapshot(ctx, dbUrl);
  if (!after.ok) {
    return {
      leaked: false,
      failure: `could not confirm the notes policies after the mutated run (${after.notes})`,
    };
  }
  if (sameSnapshot(after.snapshot, baseline)) return { leaked: false };
  const restored = await restoreNotesAccess(ctx, dbUrl, baseline);
  return restored.ok
    ? { leaked: true }
    : {
        leaked: true,
        failure: `the file committed the mutation and the scorer could not restore the notes policies (${restored.notes})`,
      };
}

/** Runs `file` under the policies `script` sets up, then settles the notes policies back to `baseline`. */
async function runSettled(
  ctx: ExecContext,
  dbUrl: string,
  file: string,
  baseline: NotesAccessSnapshot,
  script: string,
  marker: string
) {
  const run = await runMutated(ctx, dbUrl, file, script, marker);
  return { run, ...(await settleNotesAccess(ctx, dbUrl, baseline)) };
}

/** Runs each file under the seeded policies and then under each twin in turn, stopping at the first file whose policies cannot be confirmed back in place. */
async function mutateFiles(
  ctx: ExecContext,
  dbUrl: string,
  files: readonly string[],
  baseline: NotesAccessSnapshot
): Promise<{ catches: CatchRun[]; unmutated: string[] }> {
  const sessions = [
    [buildMutationSql(), MUTATION_MARKER],
    [buildOwnerOnlyTwinSql(), OWNER_ONLY_TWIN_MARKER],
    [buildOpenReadsTwinSql(), OPEN_READS_TWIN_MARKER],
  ] as const;
  const catches: CatchRun[] = [];
  for (const [index, file] of files.entries()) {
    const runs: MutatedRun[] = [];
    let leaked = false;
    let restoreFailure: string | undefined;
    for (const [script, marker] of sessions) {
      const settled = await runSettled(
        ctx,
        dbUrl,
        file,
        baseline,
        script,
        marker
      );
      runs.push(settled.run);
      leaked ||= settled.leaked;
      if (settled.failure !== undefined) {
        restoreFailure = settled.failure;
        break;
      }
    }
    catches.push({
      file,
      mutated: runs[0],
      ownerOnly: runs[1] ?? null,
      openReads: runs[2] ?? null,
      ...(leaked ? { leaked: true } : {}),
      ...(restoreFailure === undefined ? {} : { restoreFailure }),
    });
    if (restoreFailure !== undefined) {
      return { catches, unmutated: files.slice(index + 1) };
    }
  }
  return { catches, unmutated: [] };
}

/** Mutates every file, then drops the probe function a file's own commit may have left behind; the drop's failure is ignored. */
async function runMutations(
  ctx: ExecContext,
  dbUrl: string,
  files: readonly string[],
  baseline: NotesAccessSnapshot
): Promise<{ catches: CatchRun[]; unmutated: string[] }> {
  try {
    return await mutateFiles(ctx, dbUrl, files, baseline);
  } finally {
    await ctx
      .exec(psqlCommand(dbUrl, [`-c "${DROP_PROBE_FUNCTION_SQL}"`]))
      .catch(() => undefined);
  }
}

/** Runs every pgTAP file clean, then each passing file under the seeded policies and under the two identical-policy twins; never throws. */
export async function runSuite(
  ctx: ExecContext,
  stack: StackProbe
): Promise<SuiteProbe> {
  if (!stack.ok) return { ok: false, notes: stack.notes };
  try {
    const listing = await listTestFiles(ctx);
    if (!listing.ok) return listing;
    const { files } = listing;
    if (files.length === 0) return { ok: true, files, clean: [], catches: [] };
    return await withPgtap<SuiteProbe>(ctx, stack.dbUrl, async () => {
      const clean: TestFileRun[] = [];
      for (const file of files) {
        clean.push(await runFile(ctx, stack.dbUrl, file));
      }
      const passing = clean.filter((run) => run.passed).map((run) => run.file);
      if (passing.length === 0) {
        return { ok: true, files, clean, catches: [] };
      }
      const baseline = await readNotesSnapshot(ctx, stack.dbUrl);
      if (!baseline.ok) {
        return {
          ok: true,
          files,
          clean,
          catches: [],
          mutationBlocked: `${baseline.notes}, so no test file was run under the seeded policies`,
        };
      }
      const { catches, unmutated } = await runMutations(
        ctx,
        stack.dbUrl,
        passing,
        baseline.snapshot
      );
      return {
        ok: true,
        files,
        clean,
        catches,
        ...(unmutated.length > 0 ? { unmutated } : {}),
      };
    });
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

function numberedResults(tap: TapResult): Map<number, TapEntry> {
  const byNumber = new Map<number, TapEntry>();
  for (const [index, entry] of tap.results.entries()) {
    const number = entry.number ?? index + 1;
    if (!byNumber.has(number)) byNumber.set(number, entry);
  }
  return byNumber;
}

type Status = 'pass' | 'fail' | 'absent' | 'other';

function statusOf(entry: TapEntry | undefined): Status {
  if (entry === undefined) return 'absent';
  if (entry.ok && !entry.todo && !entry.skip) return 'pass';
  if (!entry.ok && !entry.todo) return 'fail';
  return 'other';
}

const hasPlanProblem = ({ plans, planned, results }: TapResult) =>
  plans !== 1 || planned !== results.length;

type LeakFlip =
  | { caught: Extract<CatchVerdict, { caught: true }> }
  | { changed?: TwinDifference };

/**
 * A twin difference the seeded-leak run shares with the open-reads twin, as a test (passed under owner-only reads, failed or never ran under open reads) or as the whole file (passed outright under owner-only reads, failed its plan or stopped under open reads).
 * The twins hold identical policies, so a difference between them comes from which notes the test could read; the first one the leak run does not share comes back as `changed`.
 */
function leakFlip(
  leak: TestFileRun,
  ownerOnly: TestFileRun,
  openReads: TestFileRun
): LeakFlip {
  const underLeak = numberedResults(leak.tap);
  const underOwners = numberedResults(ownerOnly.tap);
  const underOpen = numberedResults(openReads.tap);
  const stoppedTogether = leak.stoppedAt === openReads.stoppedAt;
  let changed: TwinDifference | undefined;

  for (const [number, entry] of underOwners) {
    const openStatus = statusOf(underOpen.get(number));
    if (
      statusOf(entry) !== 'pass' ||
      (openStatus !== 'fail' && openStatus !== 'absent')
    ) {
      continue;
    }
    const leakStatus = statusOf(underLeak.get(number));
    const sameWay =
      openStatus === 'fail'
        ? leakStatus === 'fail'
        : leakStatus === 'absent' && stoppedTogether;
    if (!sameWay) {
      changed ??= { number, description: entry.description };
      continue;
    }
    return {
      caught: {
        caught: true,
        test: {
          number,
          description: entry.description,
          ranUnderOpenReads: openStatus === 'fail',
          ...(openStatus === 'absent' && leak.stoppedAt !== undefined
            ? { stoppedAt: leak.stoppedAt }
            : {}),
        },
      },
    };
  }

  for (const [number, entry] of underOpen) {
    if (statusOf(entry) !== 'fail' || underOwners.has(number)) continue;
    if (statusOf(underLeak.get(number)) !== 'fail') {
      changed ??= { number, description: entry.description };
      continue;
    }
    return {
      caught: {
        caught: true,
        test: {
          number,
          description: entry.description,
          ranUnderOpenReads: true,
          openReadsOnly: true,
        },
      },
    };
  }

  if (ownerOnly.passed && !openReads.passed) {
    const planProblem = hasPlanProblem(openReads.tap);
    const exitProblem = openReads.exitCode !== 0;
    const sharedPlan = !planProblem || hasPlanProblem(leak.tap);
    const sharedExit = !exitProblem || (leak.exitCode !== 0 && stoppedTogether);
    if ((planProblem || exitProblem) && sharedPlan && sharedExit) {
      const stopped =
        leak.stoppedAt === undefined ? {} : { stoppedAt: leak.stoppedAt };
      return {
        caught: {
          caught: true,
          passedOutright: true,
          ...(planProblem ? { failedPlan: true } : {}),
          ...(exitProblem ? { exited: stopped } : {}),
        },
      };
    }
    changed ??= { wholeFile: true };
  }
  return { changed };
}

const appliedRun = (run: MutatedRun | null): run is MutatedRun =>
  run !== null && run.mutationApplied;

/** Whether the tests catch the seeded policies, or why not: the leak run fails the same way as the open-reads twin where the owner-only twin passes, by a test or by the whole file. */
export function catchVerdict({
  mutated,
  ownerOnly,
  openReads,
  restoreFailure,
}: CatchRun): CatchVerdict {
  if (restoreFailure !== undefined) {
    return { caught: false, reason: 'unrestored' };
  }
  if (!mutated.mutationApplied) {
    return { caught: false, reason: 'leak-not-applied' };
  }
  if (mutated.passed) return { caught: false, reason: 'leak-passed' };
  if (!appliedRun(ownerOnly) || !appliedRun(openReads)) {
    return {
      caught: false,
      reason: 'twins-not-applied',
      twins: [
        ...(appliedRun(ownerOnly) ? [] : ['owner-only' as const]),
        ...(appliedRun(openReads) ? [] : ['open-reads' as const]),
      ],
    };
  }
  const flip = leakFlip(mutated, ownerOnly, openReads);
  if ('caught' in flip) return flip.caught;
  return flip.changed === undefined
    ? { caught: false, reason: 'same-under-twins' }
    : {
        caught: false,
        reason: 'leak-failed-elsewhere',
        changed: flip.changed,
      };
}

export const isCatch = (run: CatchRun) => catchVerdict(run).caught;

const TWIN_NAMES: Record<Twin, string> = {
  'owner-only': 'owner-only twin',
  'open-reads': 'open-reads twin',
};

/** `owner-only twin and open-reads twin`, for the twins in `twins`. */
export const describeTwins = (twins: readonly Twin[] = []) =>
  twins.map((twin) => TWIN_NAMES[twin]).join(' and ');

const UNDER_IDENTICAL_POLICIES = 'under identical policies';

const SEEDED_AND_OPEN =
  'with the seeded policies put back and once every signed-in user could read notes';

/** `test 2 "b cannot see a's notes" failed with the seeded policies put back and once every signed-in user could read notes, and passed when only owners could, under identical policies`. */
export const describeFlippedTest = ({
  number,
  description,
  ranUnderOpenReads,
  openReadsOnly,
  stoppedAt,
}: FlippedTest) => {
  const test = `test ${number} "${description}"`;
  if (openReadsOnly) {
    return `${test} failed ${SEEDED_AND_OPEN}, and did not run when only owners could, ${UNDER_IDENTICAL_POLICIES}`;
  }
  if (ranUnderOpenReads) {
    return `${test} failed ${SEEDED_AND_OPEN}, and passed when only owners could, ${UNDER_IDENTICAL_POLICIES}`;
  }
  const stopped =
    stoppedAt === undefined
      ? 'both ended early'
      : `both stopped at ${stoppedAt}`;
  return `${test} did not run with the seeded policies put back or once every signed-in user could read notes (${stopped}), and passed when only owners could, ${UNDER_IDENTICAL_POLICIES}`;
};

/** What made a catch count: the test that flipped between the twins, or the file passing outright only when owners alone could read notes. */
export const describeCatchBasis = (
  verdict: Extract<CatchVerdict, { caught: true }>
) => {
  if ('test' in verdict) return describeFlippedTest(verdict.test);
  const how = [
    ...(verdict.failedPlan ? ['failed its plan'] : []),
    ...(verdict.exited === undefined
      ? []
      : [
          verdict.exited.stoppedAt === undefined
            ? 'exited non-zero'
            : `stopped at ${verdict.exited.stoppedAt}`,
        ]),
  ].join(' and ');
  return `it ${how} ${SEEDED_AND_OPEN}, and passed outright when only owners could, ${UNDER_IDENTICAL_POLICIES}`;
};

/** What the note says about a file whose twins differ but whose leak run failed on another assertion. */
export const describeLeakFailedElsewhere = (changed: TwinDifference) =>
  `${'wholeFile' in changed ? "the file's overall result" : `test ${changed.number} "${changed.description}"`} changed between the identical-policy runs, but it did not fail the same way with the seeded policies put back (it passed, was skipped, or the run stopped somewhere else), so the file failed under the leak on a different assertion, such as one about how the policies are written`;

const firstFailing = (run: TestFileRun) =>
  run.tap.results.find((entry) => !entry.ok && !entry.todo);

const noTestFiles = `no test files in ${TESTS_DIR}`;

/** Passes when every pgTAP file passes on a clean run and the files hold at least one test. */
export function checkTestsPass(suite: SuiteProbe): CheckResult {
  const name = TESTS_PASS_CHECK_NAME;
  if (!suite.ok) return { name, passed: false, notes: suite.notes };
  if (suite.files.length === 0) {
    return { name, passed: false, notes: noTestFiles };
  }
  const failed = suite.clean.filter((run) => !run.passed);
  if (failed.length > 0) {
    const notes = failed
      .map((run) => {
        const failing = firstFailing(run);
        return `${run.file}: ${run.detail}; ${describeTapCounts(run.tap)}${failing === undefined ? '' : `; first failing test: "${failing.description}"`}`;
      })
      .join(' | ');
    return { name, passed: false, notes };
  }
  const tests = suite.clean.reduce(
    (sum, run) => sum + run.tap.results.length,
    0
  );
  if (tests === 0) {
    return {
      name,
      passed: false,
      notes: `${suite.files.join(', ')} hold no tests`,
    };
  }
  return {
    name,
    passed: true,
    notes: `${tests} test(s) in ${suite.files.length} file(s) passed`,
  };
}

function describeNotCaught(
  { file, mutated, ownerOnly, openReads, restoreFailure }: CatchRun,
  verdict: Extract<CatchVerdict, { caught: false }>
): string {
  switch (verdict.reason) {
    case 'unrestored':
      return `${file}: ${restoreFailure}, so the run is not counted`;
    case 'leak-not-applied':
      return `${file}: the mutation did not apply (${mutated.detail}), so the run proves nothing`;
    case 'leak-passed':
      return `${file}: the tests still passed with the seeded policies put back`;
    case 'twins-not-applied': {
      const twins = verdict.twins ?? [];
      const details = twins.map(
        (twin) =>
          (twin === 'owner-only' ? ownerOnly : openReads)?.detail ?? 'not run'
      );
      return `${file}: the identical-policy runs (${describeTwins(twins)}) did not apply (${details.join('; ')}), so the run proves nothing`;
    }
    case 'same-under-twins':
      return `${file}: failed with the seeded policies put back, but its results did not change when every signed-in user could read notes ${UNDER_IDENTICAL_POLICIES}, so it checks how the policies are written, not who can see which notes`;
    case 'leak-failed-elsewhere':
      return `${file}: ${describeLeakFailedElsewhere(verdict.changed)}`;
  }
}

const describeUnmutated = (files: readonly string[] | undefined) =>
  files === undefined || files.length === 0
    ? ''
    : `; not run under the seeded policies because they could not be restored: ${files.join(', ')}`;

/** Passes when at least one pgTAP file passes clean, fails once the seeded policies are put back, and fails the same way as the open-reads twin where the owner-only twin passes. */
export function checkTestsCatchSeededPolicies(suite: SuiteProbe): CheckResult {
  const name = TESTS_CATCH_CHECK_NAME;
  if (!suite.ok) return { name, passed: false, notes: suite.notes };
  if (suite.files.length === 0) {
    return { name, passed: false, notes: noTestFiles };
  }
  if (suite.mutationBlocked !== undefined) {
    return { name, passed: false, notes: suite.mutationBlocked };
  }
  if (suite.catches.length === 0) {
    const failed = suite.clean.filter((run) => !run.passed);
    return {
      name,
      passed: false,
      notes: `no test file passed on a clean run, so none can show it catches the policies (${failed.map((run) => `${run.file} failed: ${run.detail}`).join(' | ')})`,
    };
  }
  const caught: string[] = [];
  const missed: string[] = [];
  for (const attempt of suite.catches) {
    const verdict = catchVerdict(attempt);
    if (verdict.caught) {
      const restored = attempt.leaked
        ? '; the file committed the mutation, so the scorer restored the notes policies between the runs'
        : '';
      caught.push(`${attempt.file}: ${describeCatchBasis(verdict)}${restored}`);
    } else {
      missed.push(describeNotCaught(attempt, verdict));
    }
  }
  return caught.length > 0
    ? {
        name,
        passed: true,
        notes: `${caught.join('; ')}${describeUnmutated(suite.unmutated)}`,
      }
    : {
        name,
        passed: false,
        notes: `${missed.join(' | ')}${describeUnmutated(suite.unmutated)}`,
      };
}
