import { basename } from 'node:path';
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

/** A later tool call whose command names a file a `db query` run wrote. */
export type SavedOutputRead = DbQueryRun & {
  path: string;
  savedBy: number;
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
const REDIRECT_RE = /(?<![->])&?>>?\s*(?![&=])(["']?)([^\s"'|;&<>()]+)\1/g;
const TEE_RE = /\btee((?:\s+["']?[^\s"'|;&<>()]+["']?)+)/g;
const PATH_SEPARATORS_RE = /[\s"'`|;&<>()=]+/;

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
  return indexes.map((commandIndex) =>
    describeCall(
      commandIndex,
      entries[commandIndex].command,
      calls[commandIndex]
    )
  );
}

function describeCall(
  commandIndex: number,
  command: string,
  { result, error }: ToolCallRecord
): DbQueryRun {
  const output = collectStringValues([result, error])
    .join('\n')
    .replace(ANSI_RE, '');
  return {
    commandIndex,
    command,
    output,
    errored: error !== undefined,
    showsAnswer: ANSWER_VALUE_RE.test(output),
  };
}

const unescapeQuotes = (command: string): string =>
  command.replace(/\\(["\\])/g, '$1');

const withoutDotSlash = (path: string): string => path.replace(/^\.\//, '');

const isOutputPath = (path: string): boolean =>
  /\w/.test(path) && !/^\d+$/.test(path) && path !== '/dev/null';

/** The files a command writes with `>`, `>>`, `&>` or `tee`, in the order written; fd duplications such as `2>&1` and `/dev/null` are not files. */
export function savedOutputPaths(command: string): string[] {
  const text = unescapeQuotes(command);
  const redirected = [...text.matchAll(REDIRECT_RE)].map(
    ([, , target]) => target
  );
  const teed = [...text.matchAll(TEE_RE)].flatMap(([, args]) =>
    args
      .trim()
      .split(/\s+/)
      .map((arg) => arg.replace(/^["']|["']$/g, ''))
      .filter((arg) => !arg.startsWith('-'))
  );
  return [
    ...new Set(
      [...redirected, ...teed].map(withoutDotSlash).filter(isOutputPath)
    ),
  ];
}

/** Whether `command` names `path` as a whole token, as written or by its basename since the reader may `cd` first. */
function mentionsPath(command: string, path: string): boolean {
  const tokens = new Set(
    unescapeQuotes(command).split(PATH_SEPARATORS_RE).map(withoutDotSlash)
  );
  return tokens.has(path) || tokens.has(basename(path));
}

/** The later tool calls that name a file a `db query` run saved, one per call, credited to the latest run that wrote it. */
export function findSavedOutputReads(
  toolCalls: readonly ToolCallRecord[],
  runs: readonly DbQueryRun[]
): SavedOutputRead[] {
  const calls = commandToolCalls(toolCalls);
  const entries = extractCommandEntries(toolCalls);
  const runIndexes = new Set(runs.map(({ commandIndex }) => commandIndex));
  const saves = runs.map((run) => ({
    commandIndex: run.commandIndex,
    paths: savedOutputPaths(run.command),
  }));
  return entries.flatMap(({ command }, commandIndex): SavedOutputRead[] => {
    if (runIndexes.has(commandIndex)) return [];
    for (const save of saves
      .filter((s) => s.commandIndex < commandIndex)
      .reverse()) {
      const path = save.paths.find((candidate) =>
        mentionsPath(command, candidate)
      );
      if (path !== undefined) {
        return [
          {
            ...describeCall(commandIndex, command, calls[commandIndex]),
            path,
            savedBy: save.commandIndex,
          },
        ];
      }
    }
    return [];
  });
}

/** Settles the check when no run happened or a run or a read of its saved output printed the count, and leaves the rest to the judge. */
export function gateAnswerSource(
  runs: readonly DbQueryRun[],
  reads: readonly SavedOutputRead[]
): CheckResult | undefined {
  const name = ANSWER_SOURCE_CHECK;
  if (runs.length === 0) {
    return { name, passed: false, notes: 'no supabase db query ran' };
  }
  const found = runs.find(({ showsAnswer }) => showsAnswer);
  if (found !== undefined) {
    return {
      name,
      passed: true,
      notes: `tool call ${found.commandIndex + 1} ran supabase db query and printed ${SEEDED.neverOrdered}`,
    };
  }
  const foundRead = reads.find(({ showsAnswer }) => showsAnswer);
  return foundRead === undefined
    ? undefined
    : {
        name,
        passed: true,
        notes: `tool call ${foundRead.commandIndex + 1} read ${foundRead.path}, saved by the supabase db query in tool call ${foundRead.savedBy + 1}, and printed ${SEEDED.neverOrdered}`,
      };
}

/** Every run, then every read of its saved output, in full and numbered by tool call. */
export function formatAnswerSourceJudgeInput(
  runs: readonly DbQueryRun[],
  reads: readonly SavedOutputRead[]
): string {
  const section = (label: string, { command, output }: DbQueryRun) =>
    `${label}\nCommand:\n${command}\nOutput:\n${output}`;
  return [
    ...runs.map((run) =>
      section(
        `Tool call ${run.commandIndex + 1}${run.errored ? ' (errored)' : ''}`,
        run
      )
    ),
    ...reads.map((read) =>
      section(
        `Tool call ${read.commandIndex + 1} (reads ${read.path}, saved by the supabase db query in tool call ${read.savedBy + 1}${read.errored ? ', errored' : ''})`,
        read
      )
    ),
  ].join('\n\n');
}

const assistantTexts = (parts: readonly TranscriptPart[]): string[] =>
  parts.flatMap((part) =>
    part.type === 'message' &&
    part.role === 'assistant' &&
    part.content.trim() !== ''
      ? [part.content]
      : []
  );

/** Every non-empty assistant message after the last tool call, joined; the last non-empty one overall when none follows it. */
export function finalReply(
  transcript: readonly TranscriptPart[]
): string | undefined {
  const lastToolCall = transcript
    .map(({ type }) => type)
    .lastIndexOf('tool_call');
  const after = assistantTexts(transcript.slice(lastToolCall + 1));
  return after.length > 0
    ? after.join('\n\n')
    : assistantTexts(transcript).at(-1);
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
