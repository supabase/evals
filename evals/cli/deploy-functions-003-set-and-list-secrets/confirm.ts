import type { CheckResult, ToolCallRecord } from '@supabase-evals/core';
import { commandToolCalls, extractCommandEntries } from '../lib/detours.js';
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
  const exitedCleanly = lists.find(({ errored }) => !errored);
  if (exitedCleanly) {
    return {
      name,
      passed: true,
      notes: `\`supabase secrets list\` in tool call ${exitedCleanly.commandIndex + 1} exited cleanly`,
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
  return {
    name,
    passed: false,
    notes: `${subject} errored and ${shown.length > 0 ? `showed only ${shown.join(', ')} and ` : ''}didn't show ${best.missing.join(', ')}`,
  };
}
