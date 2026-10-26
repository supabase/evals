import type { ToolCallRecord } from '@supabase-evals/core';
import {
  invocationPositionals,
  type SupabaseInvocation,
} from './cli-invocations.js';
import {
  commandToolCalls,
  extractCommandEntries,
  leadingWord,
  unmaskedCommandSegments,
} from './detours.js';
import { collectStringValues } from './stack-list.js';

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
export type PgProveSummary = {
  result: 'PASS' | 'FAIL' | null;
  files: number | null;
  tests: number | null;
};
export type TestDbRun = {
  commandIndex: number;
  summary: PgProveSummary | null;
  withPgProve?: true;
  /** Every `supabase test db` in the call ran with no path argument, so it covered the whole `supabase/tests` directory. */
  wholeDirectory?: true;
};

const PLAN_RE = /^1\.\.(\d+)(?:\s+#.*)?$/;
const RESULT_RE = /^(not )?ok\b(?:\s+(\d+))?\s*(?:-\s*)?(.*)$/;
const DIRECTIVE_RE = /(?:^|\s+)#\s*(todo|skip)\b.*$/i;
const HAVE_RE = /^#\s+have:\s*(.*)$/;
const WANT_RE = /^#\s+want:\s*(.*)$/;
const SUMMARY_RESULT_RE = /^Result:\s+(PASS|FAIL)\s*$/gm;
const SUMMARY_COUNTS_RE = /^Files=(\d+),\s*Tests=(\d+)\b/gm;

function readResult(line: string): TapEntry | undefined {
  const match = RESULT_RE.exec(line);
  if (match === null) return undefined;
  const directive = DIRECTIVE_RE.exec(match[3])?.[1].toLowerCase();
  return {
    ok: match[1] === undefined,
    number: match[2] === undefined ? null : Number(match[2]),
    description: match[3].replace(DIRECTIVE_RE, '').trim(),
    todo: directive === 'todo',
    ...(directive === 'skip' ? { skip: true } : {}),
  };
}

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
    const result = readResult(line);
    if (result !== undefined) results.push(result);
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

/** Lists each failing test as `not ok 2 - description (have 300, want 2700)`, with the pgTAP diagnostics when it printed them. */
export function describeTapFailures(output: string): string[] {
  const failures: { entry: TapEntry; have?: string; want?: string }[] = [];
  let current: (typeof failures)[number] | undefined;
  for (const raw of output.split('\n')) {
    const line = raw.trimEnd();
    const entry = readResult(line);
    if (entry !== undefined) {
      current = entry.ok || entry.todo ? undefined : { entry };
      if (current !== undefined) failures.push(current);
      continue;
    }
    if (current === undefined) continue;
    current.have = HAVE_RE.exec(line)?.[1] ?? current.have;
    current.want = WANT_RE.exec(line)?.[1] ?? current.want;
  }
  return failures.map(({ entry, have, want }) => {
    const label = [
      'not ok',
      ...(entry.number === null ? [] : [String(entry.number)]),
      ...(entry.description === '' ? [] : ['-', entry.description]),
    ].join(' ');
    return have === undefined || want === undefined
      ? label
      : `${label} (have ${have}, want ${want})`;
  });
}

/** Reads the last `Result:` line and the last `Files=N, Tests=M` line of `pg_prove` output; null when it printed neither. */
export function readPgProveSummary(text: string): PgProveSummary | null {
  const result = [...text.matchAll(SUMMARY_RESULT_RE)].at(-1)?.[1];
  const counts = [...text.matchAll(SUMMARY_COUNTS_RE)].at(-1);
  if (result === undefined && counts === undefined) return null;
  return {
    result: result === undefined ? null : (result as 'PASS' | 'FAIL'),
    files: counts === undefined ? null : Number(counts[1]),
    tests: counts === undefined ? null : Number(counts[2]),
  };
}

/** Renders a summary as `PASS (Files=2, Tests=9)`, or just the result when the counts are missing. */
export function describePgProveSummary({
  result,
  files,
  tests,
}: PgProveSummary): string {
  const label = result ?? 'no result line';
  return files === null || tests === null
    ? label
    : `${label} (Files=${files}, Tests=${tests})`;
}

/** Whether the invocation is `supabase test db` or its hidden alias `supabase db test`. */
export function isTestDbInvocation(invocation: SupabaseInvocation): boolean {
  const [first, second] = invocationPositionals(invocation);
  return (
    (first === 'test' && second === 'db') ||
    (first === 'db' && second === 'test')
  );
}

/** Whether the command runs `pg_prove` by hand in any executable segment. */
export function runsPgProve(command: string): boolean {
  return unmaskedCommandSegments(command).some(
    (segment) => leadingWord(segment) === 'pg_prove'
  );
}

/** One run per tool call that executed `supabase test db`, with the summary its output printed; a call that also ran `pg_prove` gets none, since either command could have printed it. */
export function findTestDbRuns(
  toolCalls: readonly ToolCallRecord[],
  invocations: readonly SupabaseInvocation[]
): TestDbRun[] {
  const calls = commandToolCalls(toolCalls);
  const entries = extractCommandEntries(toolCalls);
  const testDbInvocations = invocations.filter(isTestDbInvocation);
  const indexes = [
    ...new Set(testDbInvocations.map((invocation) => invocation.commandIndex)),
  ].sort((a, b) => a - b);
  return indexes.map((commandIndex) => {
    if (runsPgProve(entries[commandIndex].command)) {
      return { commandIndex, summary: null, withPgProve: true };
    }
    const { result, error } = calls[commandIndex];
    const output = collectStringValues([result, error]).join('\n');
    const wholeDirectory = testDbInvocations
      .filter((invocation) => invocation.commandIndex === commandIndex)
      .every((invocation) => invocationPositionals(invocation).length === 2);
    return {
      commandIndex,
      summary: readPgProveSummary(output),
      ...(wholeDirectory ? { wholeDirectory: true as const } : {}),
    };
  });
}
