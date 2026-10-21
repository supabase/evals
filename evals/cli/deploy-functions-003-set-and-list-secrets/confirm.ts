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
const NULL_DEVICE = '/dev/null';
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
  /** The innermost `(…)` group the segment runs in; 0 is the top level. */
  group: number;
};

type Group = {
  parent: number;
  /** The segment holding the command that wrote the group's `(`. */
  owner?: number;
  processSubstitution: boolean;
};

type ParsedCommand = { segments: Segment[]; groups: Group[] };

/** The command's executable segments and the `(…)` groups around them; `piped` is read from the raw command, so a segment that isn't found there verbatim is never piped. */
function parseCommand(command: string): ParsedCommand {
  const groups: Group[] = [{ parent: -1, processSubstitution: false }];
  const segments: Segment[] = [];
  let current = 0;
  let cursor = 0;
  scopedCommandSegments(command).forEach(({ segment, opens, closes }, i) => {
    for (let n = 0; n < opens; n++) {
      groups.push({
        parent: current,
        owner: n === 0 ? ownerOfNewGroup(segments, groups, current) : undefined,
        processSubstitution:
          n === 0 && /[<>]$/.test(segments[i - 1]?.text ?? ''),
      });
      current = groups.length - 1;
    }
    const verb = findSupabaseInvocations([segment])
      .map(secretsVerb)
      .find((v) => v !== undefined);
    const start = command.indexOf(segment, cursor);
    if (start !== -1) cursor = start + segment.length;
    segments.push({
      text: segment,
      verb,
      piped: start !== -1 && PIPE_RE.test(command.slice(cursor)),
      group: current,
    });
    for (let n = 0; n < closes && current > 0; n++) {
      current = groups[current].parent;
    }
  });
  return { segments, groups };
}

/** The segment whose command a `(` after the last segment belongs to; when the last segment closed a group, that group's own owner. */
function ownerOfNewGroup(
  segments: readonly Segment[],
  groups: readonly Group[],
  current: number
): number | undefined {
  if (segments.length === 0) return undefined;
  let group = segments[segments.length - 1].group;
  if (group === current) return segments.length - 1;
  while (groups[group].parent !== current) group = groups[group].parent;
  return groups[group].owner;
}

/** The segments that consume the output of `segments[index]`: its whole pipeline plus the `(…)` groups its stages own, and the same for each enclosing process substitution's command. */
function consumers(
  { segments, groups }: ParsedCommand,
  index: number
): Segment[] {
  const inside = (group: number, ancestor: number): boolean =>
    group === ancestor || (group > 0 && inside(groups[group].parent, ancestor));
  const unit = new Set<number>();
  const addPipeline = (at: number) => {
    let first = at;
    while (first > 0 && segments[first - 1].piped) first--;
    let last = at;
    while (last < segments.length - 1 && segments[last].piped) last++;
    for (let stage = first; stage <= last; stage++) {
      unit.add(stage);
      groups.forEach(({ owner }, group) => {
        if (owner !== stage) return;
        segments.forEach((member, i) => {
          if (inside(member.group, group)) unit.add(i);
        });
      });
    }
  };
  addPipeline(index);
  for (let group = segments[index].group; groups[group].processSubstitution; ) {
    const { owner } = groups[group];
    if (owner === undefined) break;
    addPipeline(owner);
    group = segments[owner].group;
  }
  return [...unit].map((i) => segments[i]);
}

/** Whether a segment picked by `isSource` has consumers, apart from any `secrets` command, that name every secret or mention the production file. */
function checksExpectedNames(
  command: ParsedCommand,
  isSource: (segment: Segment) => boolean
): boolean {
  return command.segments.some((segment, i) => {
    if (!isSource(segment)) return false;
    const text = consumers(command, i)
      .filter(({ verb }) => verb === undefined)
      .map(({ text }) => text)
      .join('\n');
    return text.includes(PRODUCTION_FILE) || missingNames(text).length === 0;
  });
}

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
      target !== ''
      ? [target.replace(/^\.\//, '')]
      : [];
  });
}

const discardsStdout = (segment: string) =>
  stdoutTargets(segment).includes(NULL_DEVICE);

/** Files a `secrets list` segment, or the last segment of the pipeline holding it, sends stdout to with `>` or `>>`, other than /dev/null. */
function listRedirectTargets({ segments }: ParsedCommand): string[] {
  return segments
    .flatMap(({ verb }, i) => {
      if (verb !== 'list') return [];
      let last = i;
      while (segments[last].piped && last + 1 < segments.length) last++;
      return [
        ...stdoutTargets(segments[i].text),
        ...stdoutTargets(segments[last].text),
      ];
    })
    .filter((target) => target !== NULL_DEVICE);
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

  const parsed = (commandIndex: number) => parseCommand(commands[commandIndex]);

  for (const { commandIndex } of lists) {
    const targets = listRedirectTargets(parsed(commandIndex));
    for (let i = commandIndex + 1; i < calls.length; i++) {
      const file = targets.find((path) => mentionsPath(commands[i], path));
      if (file === undefined) continue;
      if (missingNames(callText(calls[i])).length === 0) {
        return {
          name,
          passed: true,
          notes: `\`supabase secrets list\` in tool call ${commandIndex + 1} saved its output to a file that tool call ${i + 1} read back showing every secret name`,
        };
      }
      if (
        calls[i].error === undefined &&
        checksExpectedNames(parsed(i), ({ text }) => mentionsPath(text, file))
      ) {
        return {
          name,
          passed: true,
          notes: `\`supabase secrets list\` in tool call ${commandIndex + 1} was saved to ${file} and checked against the expected names in tool call ${i + 1}`,
        };
      }
    }
  }

  const checked = lists.find(
    ({ commandIndex, errored }) =>
      !errored &&
      checksExpectedNames(
        parsed(commandIndex),
        ({ verb, text }) => verb === 'list' && !discardsStdout(text)
      )
  );
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
