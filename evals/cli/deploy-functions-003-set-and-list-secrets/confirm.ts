import type { CheckResult, ToolCallRecord } from '@supabase-evals/core';
import { parse as shellQuoteParse, type ParseEntry } from 'shell-quote';
import {
  commandToolCalls,
  extractCommandEntries,
  extractCommands,
  scopedCommandSegments,
} from '../lib/detours.js';
import {
  findSupabaseInvocations,
  invocationSubcommand,
  invocationVerb,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { stripTerminalEscapes } from './echo.js';
import { NO_HOSTED_PROJECT } from './hosted.js';
import { SECRET_NAMES } from './seed.js';

export const CONFIRM_CHECK_NAME =
  "the agent listed the project's secrets after setting them";

const SECRETS_VERBS = new Set(['set', 'unset', 'list']);
const PRODUCTION_FILE = '.env.production';
const STDOUT_REDIRECTS = new Set(['>', '>>']);
const OTHER_FD_RE = /^[2-9]\d*$/;
const PIPE_RE = /^\s*\|(?!\|)/;

type SecretsVerb = 'set' | 'unset' | 'list';

/** The verb of a `supabase secrets <verb>` invocation, or undefined for any other command. */
export function secretsVerb(inv: SupabaseInvocation): SecretsVerb | undefined {
  const verb = invocationSubcommand(inv);
  return invocationVerb(inv) === 'secrets' &&
    verb !== undefined &&
    SECRETS_VERBS.has(verb)
    ? (verb as SecretsVerb)
    : undefined;
}

function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === null || result === undefined) return '';
  return JSON.stringify(result).replace(/\\[nrt]/g, ' ');
}

/** A call's result and error together: a command that exits non-zero keeps its output in `error`. */
function callText({ result, error }: ToolCallRecord): string {
  return stripTerminalEscapes(`${resultText(result)}\n${error ?? ''}`);
}

const missingNames = (text: string) =>
  SECRET_NAMES.filter(
    (name) => !new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text)
  );

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type Segment = {
  text: string;
  verb?: SecretsVerb;
  /** A `|` follows this segment directly, joining it to the next one. */
  piped: boolean;
};

/** The command's executable segments; `piped` is read from the raw command, so a segment that isn't found there verbatim is never piped. */
function pipedSegments(command: string): Segment[] {
  let cursor = 0;
  return scopedCommandSegments(command).map(({ segment }) => {
    const verb = findSupabaseInvocations([segment])
      .map(secretsVerb)
      .find((v) => v !== undefined);
    const start = command.indexOf(segment, cursor);
    if (start === -1) return { text: segment, verb, piped: false };
    cursor = start + segment.length;
    return {
      text: segment,
      verb,
      piped: PIPE_RE.test(command.slice(cursor)),
    };
  });
}

/** The command's text outside any `secrets set` or `secrets unset` segment. */
const textOutsideWrites = (segments: readonly Segment[]) =>
  segments
    .filter(({ verb }) => verb !== 'set' && verb !== 'unset')
    .map(({ text }) => text)
    .join('\n');

function stdoutTargets(segment: string): string[] {
  let tokens: ParseEntry[];
  try {
    tokens = shellQuoteParse(segment, (key) => `$${key}`);
  } catch {
    return [];
  }
  return tokens.flatMap((token, i) => {
    const before = tokens[i - 1];
    const target = tokens[i + 1];
    return typeof token === 'object' &&
      'op' in token &&
      STDOUT_REDIRECTS.has(token.op) &&
      !(typeof before === 'string' && OTHER_FD_RE.test(before)) &&
      typeof target === 'string' &&
      target !== '' &&
      target !== '/dev/null'
      ? [target.replace(/^\.\//, '')]
      : [];
  });
}

/** Files a `secrets list` segment, or the last segment of the pipeline holding it, sends stdout to with `>` or `>>`, other than /dev/null. */
function listRedirectTargets(segments: readonly Segment[]): string[] {
  return segments.flatMap(({ verb }, i) => {
    if (verb !== 'list') return [];
    let last = i;
    while (segments[last].piped && last + 1 < segments.length) last++;
    return [
      ...stdoutTargets(segments[i].text),
      ...stdoutTargets(segments[last].text),
    ];
  });
}

const mentionsPath = (command: string, path: string) =>
  new RegExp(`(?<![\\w.-])${escapeRegExp(path)}(?![\\w.-])`).test(command);

export function checkListedAfterSet(
  hosted: boolean,
  toolCalls: readonly ToolCallRecord[],
  invocations: readonly SupabaseInvocation[] = findSupabaseInvocations(
    extractCommandEntries(toolCalls)
  )
): CheckResult {
  const name = CONFIRM_CHECK_NAME;
  if (!hosted) return { name, passed: false, notes: NO_HOSTED_PROJECT };

  const calls = commandToolCalls(toolCalls);
  const commands = extractCommands(toolCalls);
  const verbs = invocations.map((inv) => ({
    verb: secretsVerb(inv),
    commandIndex: inv.commandIndex,
  }));
  const lastWrite = verbs.reduce(
    (last, { verb }, i) => (verb === 'set' || verb === 'unset' ? i : last),
    -1
  );
  if (lastWrite === -1) {
    return { name, passed: false, notes: 'no `supabase secrets set` ran' };
  }

  const lists = verbs
    .slice(lastWrite + 1)
    .filter(({ verb }) => verb === 'list')
    .map(({ commandIndex }) => {
      const call = calls[commandIndex];
      return {
        commandIndex,
        errored: call.error !== undefined,
        missing: missingNames(callText(call)),
      };
    });
  if (lists.length === 0) {
    return {
      name,
      passed: false,
      notes:
        'no `supabase secrets list` ran after the last `supabase secrets set`',
    };
  }

  const showedAll = lists.find(({ missing }) => missing.length === 0);
  if (showedAll) {
    return {
      name,
      passed: true,
      notes: `\`supabase secrets list\` in tool call ${showedAll.commandIndex + 1} showed every secret name`,
    };
  }

  const segmentsOf = (commandIndex: number) =>
    pipedSegments(commands[commandIndex]);

  for (const { commandIndex } of lists) {
    const targets = listRedirectTargets(segmentsOf(commandIndex));
    const readBack = calls.findIndex(
      (call, i) =>
        i > commandIndex &&
        targets.some((path) => mentionsPath(commands[i], path)) &&
        missingNames(callText(call)).length === 0
    );
    if (readBack !== -1) {
      return {
        name,
        passed: true,
        notes: `\`supabase secrets list\` in tool call ${commandIndex + 1} saved its output to a file that tool call ${readBack + 1} read back showing every secret name`,
      };
    }
  }

  const checked = lists.find(({ commandIndex, errored }) => {
    if (errored) return false;
    const text = textOutsideWrites(segmentsOf(commandIndex));
    return text.includes(PRODUCTION_FILE) || missingNames(text).length === 0;
  });
  if (checked) {
    return {
      name,
      passed: true,
      notes: `\`supabase secrets list\` in tool call ${checked.commandIndex + 1} exited cleanly while checking against the expected names`,
    };
  }

  const best = lists.reduce((a, b) =>
    b.missing.length < a.missing.length ? b : a
  );
  const shown = SECRET_NAMES.filter((n) => !best.missing.includes(n));
  const subject =
    lists.length === 1
      ? 'the `supabase secrets list` after the last set'
      : `the ${lists.length} \`supabase secrets list\` runs after the last set`;
  const allErrored = lists.every(({ errored }) => errored);
  const outcome = allErrored
    ? 'errored and'
    : `${lists.some(({ errored }) => errored) ? 'errored or ' : ''}exited cleanly without checking against the expected names, and`;
  return {
    name,
    passed: false,
    notes: `${subject} ${outcome} ${shown.length > 0 ? `showed only ${shown.join(', ')} and ` : ''}didn't show ${best.missing.join(', ')}`,
  };
}
