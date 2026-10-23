import type { CheckResult, ToolCallRecord } from '@supabase-evals/core';
import {
  invocationPositionals,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import {
  commandToolCalls,
  extractCommandEntries,
  leadingWord,
  unmaskedCommandSegments,
} from '../lib/detours.js';
import { collectStringValues } from '../lib/stack-list.js';

export type TestDbSummary = {
  result: 'PASS' | 'FAIL' | null;
  tests: number | null;
};
export type TestDbRun = {
  commandIndex: number;
  summary: TestDbSummary | null;
  withPgProve?: true;
};

export const TEST_DB_CHECK_NAME = 'the tests were run with supabase test db';

const RESULT_RE = /^Result:\s+(PASS|FAIL)\s*$/gm;
const TESTS_RE = /^Files=\d+,\s*Tests=([1-9]\d*)\b/gm;

const lastMatch = (text: string, pattern: RegExp) =>
  [...text.matchAll(pattern)].at(-1)?.[1];

/** Reads the pg_prove summary `supabase test db` prints: the `Result:` line and a non-zero test count; null when it prints neither. */
export function readTestDbSummary(text: string): TestDbSummary | null {
  const result = lastMatch(text, RESULT_RE);
  const tests = lastMatch(text, TESTS_RE);
  if (result === undefined && tests === undefined) return null;
  return {
    result: result === undefined ? null : (result as 'PASS' | 'FAIL'),
    tests: tests === undefined ? null : Number(tests),
  };
}

const isTestDb = (invocation: SupabaseInvocation) => {
  const [first, second] = invocationPositionals(invocation);
  return (
    (first === 'test' && second === 'db') ||
    (first === 'db' && second === 'test')
  );
};

/** Whether the command runs `pg_prove` by hand in any executable segment. */
export const runsPgProve = (command: string) =>
  unmaskedCommandSegments(command).some(
    (segment) => leadingWord(segment) === 'pg_prove'
  );

/** One run per tool call that executed `supabase test db`, with the summary its output printed; a call that also ran `pg_prove` gets none, since either command could have printed it. */
export function findTestDbRuns(
  toolCalls: readonly ToolCallRecord[],
  invocations: readonly SupabaseInvocation[]
): TestDbRun[] {
  const calls = commandToolCalls(toolCalls);
  const entries = extractCommandEntries(toolCalls);
  const indexes = [
    ...new Set(
      invocations.filter(isTestDb).map((invocation) => invocation.commandIndex)
    ),
  ].sort((a, b) => a - b);
  return indexes.map((commandIndex) => {
    if (runsPgProve(entries[commandIndex].command)) {
      return { commandIndex, summary: null, withPgProve: true };
    }
    const { result, error } = calls[commandIndex];
    const output = collectStringValues([result, error]).join('\n');
    return { commandIndex, summary: readTestDbSummary(output) };
  });
}

/** Renders a pg_prove summary as `PASS (Tests=3)`. */
export function describeTestDbSummary({
  result,
  tests,
}: TestDbSummary): string {
  const label = result ?? 'no result line';
  return tests === null ? label : `${label} (Tests=${tests})`;
}

/** Passes when the agent ran `supabase test db` at least once and it printed a pg_prove summary. */
export function checkRanWithTestDb(runs: readonly TestDbRun[]): CheckResult {
  const name = TEST_DB_CHECK_NAME;
  if (runs.length === 0) {
    return {
      name,
      passed: false,
      notes: 'the tests were never run through supabase test db',
    };
  }
  const summarised = runs.filter((run) => run.summary !== null);
  const last = summarised.at(-1);
  if (last?.summary == null) {
    const handRun = runs
      .filter((run) => run.withPgProve)
      .map((run) => run.commandIndex + 1);
    const pgProveNote =
      handRun.length === 0
        ? ''
        : `; command(s) ${handRun.join(', ')} also ran pg_prove by hand in the same call, so the summary can't be credited to supabase test db`;
    return {
      name,
      passed: false,
      notes: `${runs.length} supabase test db run(s) printed no pg_prove summary, so no test ran through it${pgProveNote}`,
    };
  }
  return {
    name,
    passed: true,
    notes: `supabase test db printed ${describeTestDbSummary(last.summary)} (command ${last.commandIndex + 1})`,
  };
}
