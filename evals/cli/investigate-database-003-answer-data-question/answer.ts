import type {
  CheckResult,
  ToolCallRecord,
  TranscriptPart,
} from '@supabase-evals/core';
import {
  invocationPositionals,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { commandToolCalls, extractCommandEntries } from '../lib/detours.js';
import { truncate } from '../lib/shell.js';
import { collectStringValues } from '../lib/stack-list.js';
import { SEEDED } from './fixtures.js';

export const ANSWER_SOURCE_CHECK =
  'a supabase db query run returned the answer';
export const REPLY_CHECK = 'the reply gives the right count';

export type DbQueryRun = {
  commandIndex: number;
  command: string;
  output: string;
  errored: boolean;
  showsAnswer: boolean;
};

// Rows carry emails, uuids and a random boundary, so a 263 glued to a word character, `.` or `-` belongs to a longer token.
const ANSWER_VALUE_RE = new RegExp(
  `(?<![\\w.-])${SEEDED.neverOrdered}(?![\\w-]|\\.\\d)`
);
// A thousands or decimal neighbour makes another number ("1,263", "263,000", "263.5"); a trailing "." or "," does not.
const ANSWER_PROSE_RE = new RegExp(
  `(?<![\\w]|\\d[.,])${SEEDED.neverOrdered}(?![\\w]|[.,]\\d)`
);

const HELP_FLAGS = new Set(['--help', '-h']);
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Whether `reply` states the number of customers who never ordered as a whole number. */
export const replyStatesCount = (reply: string): boolean =>
  ANSWER_PROSE_RE.test(reply);

/** A `supabase db query` that runs SQL; a help request does not. */
export function isDbQueryInvocation(inv: SupabaseInvocation): boolean {
  const [first, second] = invocationPositionals(inv);
  return (
    first === 'db' &&
    second === 'query' &&
    !inv.argv.some((token) => HELP_FLAGS.has(token))
  );
}

/** One run per tool call holding a `supabase db query`, with its result and error text. */
export function findDbQueryRuns(
  toolCalls: readonly ToolCallRecord[],
  invocations: readonly SupabaseInvocation[]
): DbQueryRun[] {
  const calls = commandToolCalls(toolCalls);
  const entries = extractCommandEntries(toolCalls);
  const indexes = [
    ...new Set(
      invocations.filter(isDbQueryInvocation).map((inv) => inv.commandIndex)
    ),
  ].sort((a, b) => a - b);
  return indexes.map((commandIndex) => {
    const { result, error } = calls[commandIndex];
    const output = collectStringValues([result, error])
      .join('\n')
      .replace(ANSI_RE, '');
    return {
      commandIndex,
      command: entries[commandIndex].command,
      output,
      errored: error !== undefined,
      showsAnswer: ANSWER_VALUE_RE.test(output),
    };
  });
}

/** Settles the check when no run happened or one printed the count, and leaves the rest to the judge. */
export function gateAnswerSource(
  runs: readonly DbQueryRun[]
): CheckResult | undefined {
  const name = ANSWER_SOURCE_CHECK;
  if (runs.length === 0) {
    return { name, passed: false, notes: 'no supabase db query ran' };
  }
  const found = runs.find(({ showsAnswer }) => showsAnswer);
  return found === undefined
    ? undefined
    : {
        name,
        passed: true,
        notes: `tool call ${found.commandIndex + 1} ran supabase db query and printed ${SEEDED.neverOrdered}`,
      };
}

/** Every run in full, numbered by tool call. */
export function formatAnswerSourceJudgeInput(
  runs: readonly DbQueryRun[]
): string {
  return runs
    .map(
      ({ commandIndex, command, output, errored }) =>
        `Tool call ${commandIndex + 1}${errored ? ' (errored)' : ''}\nCommand:\n${command}\nOutput:\n${output}`
    )
    .join('\n\n');
}

/** The last non-empty assistant message. */
export function finalReply(
  transcript: readonly TranscriptPart[]
): string | undefined {
  return transcript
    .flatMap((part) =>
      part.type === 'message' &&
      part.role === 'assistant' &&
      part.content.trim() !== ''
        ? [part.content]
        : []
    )
    .at(-1);
}

export function checkReplyGivesCount(reply: string | undefined): CheckResult {
  const name = REPLY_CHECK;
  if (reply === undefined) {
    return { name, passed: false, notes: 'the agent gave no final reply' };
  }
  const passed = replyStatesCount(reply);
  return {
    name,
    passed,
    notes: passed
      ? `the reply gives ${SEEDED.neverOrdered}`
      : `the reply does not give ${SEEDED.neverOrdered}: ${truncate(reply, 300)}`,
  };
}
