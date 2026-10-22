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
};
export type MutatedRun = TestFileRun & { mutationApplied: boolean };
export type CatchRun = {
  file: string;
  mutated: MutatedRun;
  rerun: TestFileRun | null;
  leaked?: boolean;
  restoreFailure?: string;
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
export const CONTROL_MARKER = 'eval-control-run';

const PLAN_RE = /^1\.\.(\d+)(?:\s+#.*)?$/;
const RESULT_RE = /^(not )?ok\b(?:\s+(\d+))?\s*(?:-\s*)?(.*)$/;
const DIRECTIVE_RE = /\s+#\s*(todo|skip)\b.*$/i;
const NO_SUCH_DIRECTORY_RE = /No such file or directory/i;
const TEST_FILE_RE = /\.(?:sql|pg)$/;

/** Reads the TAP lines of a pgTAP run the way `pg_prove` does: plan lines, `ok`/`not ok` results and their TODO directives. */
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
    const directive = DIRECTIVE_RE.exec(result[3]);
    results.push({
      ok: result[1] === undefined,
      number: result[2] === undefined ? null : Number(result[2]),
      description: result[3].replace(DIRECTIVE_RE, '').trim(),
      todo: directive?.[1].toLowerCase() === 'todo',
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

/** SQL that opens a transaction and leaves it open with the seeded notes policies back in place, ending with the marker that proves it ran. */
export function buildMutationSql(): string {
  const policies = SEEDED_NOTES_POLICIES.map((policy) => `${policy};`).join(
    '\n'
  );
  return `begin;
${DROP_NOTES_POLICIES_SQL}
alter table public.${NOTES_TABLE} enable row level security;
${policies}
select '${MUTATION_MARKER}';
`;
}

/** SQL that opens a transaction like the mutation does, without touching any policy. */
export const buildControlSql = () => `begin;
select '${CONTROL_MARKER}';
`;

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
  return {
    file,
    passed: tapPassed(result.exitCode, tap),
    exitCode: result.exitCode,
    tap,
    detail: describeExit(result),
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
  file: string
): Promise<MutatedRun> {
  const result = await execTestFile(ctx, dbUrl, file, buildMutationSql());
  return {
    ...toRun(file, {
      ...result,
      stdout: withMarkerRemoved(result.stdout, MUTATION_MARKER),
    }),
    mutationApplied: printedMarker(result, MUTATION_MARKER),
  };
}

async function runControl(
  ctx: ExecContext,
  dbUrl: string,
  file: string
): Promise<TestFileRun> {
  const result = await execTestFile(ctx, dbUrl, file, buildControlSql());
  return toRun(file, {
    ...result,
    stdout: withMarkerRemoved(result.stdout, CONTROL_MARKER),
  });
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

/** Mutates and re-runs each file in turn, stopping at the first file whose policies cannot be confirmed back in place. */
async function runMutations(
  ctx: ExecContext,
  dbUrl: string,
  files: readonly string[],
  baseline: NotesAccessSnapshot
): Promise<{ catches: CatchRun[]; unmutated: string[] }> {
  const catches: CatchRun[] = [];
  for (const [index, file] of files.entries()) {
    const mutated = await runMutated(ctx, dbUrl, file);
    const { leaked, failure } = await settleNotesAccess(ctx, dbUrl, baseline);
    const flags = leaked ? { leaked } : {};
    if (failure !== undefined) {
      catches.push({
        file,
        mutated,
        rerun: null,
        ...flags,
        restoreFailure: failure,
      });
      return { catches, unmutated: files.slice(index + 1) };
    }
    catches.push({
      file,
      mutated,
      rerun: await runControl(ctx, dbUrl, file),
      ...flags,
    });
  }
  return { catches, unmutated: [] };
}

/** Runs every pgTAP file clean, then each passing file under the seeded-policy mutation and once more afterwards; never throws. */
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

/** Whether a mutated run shows the tests catch the seeded policies: the mutation applied, the tests failed under it, and the re-run passed. */
export const isCatch = ({ mutated, rerun }: CatchRun) =>
  mutated.mutationApplied && !mutated.passed && rerun?.passed === true;

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

function describeNotCaught({
  file,
  mutated,
  rerun,
  restoreFailure,
}: CatchRun): string {
  if (restoreFailure !== undefined) {
    return `${file}: ${restoreFailure}, so the run is not counted`;
  }
  if (!mutated.mutationApplied) {
    return `${file}: the mutation did not apply (${mutated.detail}), so the run proves nothing`;
  }
  if (mutated.passed) {
    return `${file}: the tests still passed with the seeded policies put back`;
  }
  return `${file}: failed under the mutation, but the re-run afterwards failed too (${rerun?.detail}), so the failure may be state drift rather than the policies`;
}

const describeUnmutated = (files: readonly string[] | undefined) =>
  files === undefined || files.length === 0
    ? ''
    : `; not run under the seeded policies because they could not be restored: ${files.join(', ')}`;

/** Passes when at least one pgTAP file passes clean, fails once the seeded policies are put back, and passes again on a re-run. */
export function checkTestsCatchSeededPolicies(suite: SuiteProbe): CheckResult {
  const name = TESTS_CATCH_CHECK_NAME;
  if (!suite.ok) return { name, passed: false, notes: suite.notes };
  if (suite.files.length === 0) {
    return { name, passed: false, notes: noTestFiles };
  }
  if (suite.mutationBlocked !== undefined) {
    return { name, passed: false, notes: suite.mutationBlocked };
  }
  const caught = suite.catches.filter(isCatch);
  if (caught.length > 0) {
    const notes = caught
      .map(({ file, mutated, leaked }) => {
        const failing = firstFailing(mutated);
        const restored = leaked
          ? '; the file committed the mutation, so the scorer restored the notes policies before the re-run'
          : '';
        return `${file} failed with the seeded policies put back (${failing === undefined ? mutated.detail : `first failing test: "${failing.description}"`}) and passed again on the re-run${restored}`;
      })
      .join('; ');
    return {
      name,
      passed: true,
      notes: `${notes}${describeUnmutated(suite.unmutated)}`,
    };
  }
  if (suite.catches.length === 0) {
    const failed = suite.clean.filter((run) => !run.passed);
    return {
      name,
      passed: false,
      notes: `no test file passed on a clean run, so none can show it catches the policies (${failed.map((run) => `${run.file} failed: ${run.detail}`).join(' | ')})`,
    };
  }
  return {
    name,
    passed: false,
    notes: `${suite.catches.map(describeNotCaught).join(' | ')}${describeUnmutated(suite.unmutated)}`,
  };
}
