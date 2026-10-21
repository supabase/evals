import type { CheckResult, ToolCallRecord } from '@supabase-evals/core';
import { commandToolCalls, extractCommandEntries } from '../lib/detours.js';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import { NO_HOSTED_PROJECT } from './hosted.js';
import { SECRET_NAMES } from './seed.js';

export const CONFIRM_CHECK_NAME =
  "the agent listed the project's secrets after setting them";

const VALUE_FLAGS = new Set([
  '--project-ref',
  '--env-file',
  '--workdir',
  '--profile',
  '-o',
  '--output',
  '--output-format',
  '--log-level',
  '--agent',
  '--dns-resolver',
  '--network-id',
]);

const SECRETS_VERBS = new Set(['set', 'unset', 'list']);

type SecretsVerb = 'set' | 'unset' | 'list';

/** The positional words of a `supabase` argv, with flags and the values of value-taking flags skipped. */
export function positionalWords(argv: readonly string[]): string[] {
  const words: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    if (!argv[i].startsWith('-')) words.push(argv[i]);
    else if (!argv[i].includes('=') && VALUE_FLAGS.has(argv[i])) i++;
  }
  return words;
}

/** The verb of a `supabase secrets <verb>` argv, or undefined for any other command. */
export function secretsVerb(argv: readonly string[]): SecretsVerb | undefined {
  const [group, verb] = positionalWords(argv);
  return group === 'secrets' && verb !== undefined && SECRETS_VERBS.has(verb)
    ? (verb as SecretsVerb)
    : undefined;
}

function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === null || result === undefined) return '';
  return JSON.stringify(result).replace(/\\[nrt]/g, ' ');
}

const missingNames = (text: string) =>
  SECRET_NAMES.filter(
    (name) => !new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text)
  );

export function checkListedAfterSet(
  hosted: boolean,
  toolCalls: readonly ToolCallRecord[]
): CheckResult {
  const name = CONFIRM_CHECK_NAME;
  if (!hosted) return { name, passed: false, notes: NO_HOSTED_PROJECT };

  const calls = commandToolCalls(toolCalls);
  const verbs = findSupabaseInvocations(extractCommandEntries(toolCalls)).map(
    ({ argv, commandIndex }) => ({ verb: secretsVerb(argv), commandIndex })
  );
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
    .map(({ commandIndex }) => ({
      commandIndex,
      missing: missingNames(resultText(calls[commandIndex].result)),
    }));
  if (lists.length === 0) {
    return {
      name,
      passed: false,
      notes:
        'no `supabase secrets list` ran after the last `supabase secrets set`',
    };
  }

  const best = lists.reduce((a, b) =>
    b.missing.length < a.missing.length ? b : a
  );
  return best.missing.length === 0
    ? {
        name,
        passed: true,
        notes: `\`supabase secrets list\` in tool call ${best.commandIndex + 1} showed every secret name`,
      }
    : {
        name,
        passed: false,
        notes: `the \`supabase secrets list\` after the last set didn't show: ${best.missing.join(', ')}`,
      };
}
