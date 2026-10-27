import { stripVTControlCharacters } from 'node:util';
import type { CheckResult, ToolCallRecord } from '@supabase-evals/core';
import type { SupabaseInvocation } from '../lib/cli-invocations.js';
import { commandToolCalls, extractCommands } from '../lib/detours.js';
import { NO_HOSTED_PROJECT } from './hosted.js';

export const DENIAL_CHECK_NAME = 'the CLI denied the request on plan grounds';
export const LINK_CHECK_NAME = 'the agent passed on the upgrade link';

export type PlanGateDenial = {
  /** Index into the tool calls, which is also the ordinal of its `tool_call` transcript part. */
  toolCallIndex: number;
  command: string;
  output: string;
  feature: string | null;
  upgradeUrls: string[];
  /** The output carries an unescaped `entitlement` object, the field only the beta CLI adds to its JSON error. */
  structuredEntitlement: boolean;
  machineOutput: boolean;
};

const DENIAL_SIGNAL =
  /entitlement_required|does not have access to this feature/i;
const HINT_URL = /Upgrade your plan:\s*(https?:\/\/[^\s"'\\<>]+)/gi;
// Agent runs default to `--output-format json`, which prints no text hint: the link then survives only as the escaped `upgrade_url` in `error.message`.
const UPGRADE_URL_FIELD =
  /\\?"upgrade_url\\?"\s*:\s*\\?"(https?:\/\/[^"\\\s]+)/g;
const BILLING_URL = /https?:\/\/[^\s"'\\<>]*\/org\/[^/\s"'\\<>]+\/billing/g;
const FEATURE = /\\?"feature\\?"\s*:\s*\\?"([^"\\]+)/;
// A backslash before the quote marks the field as escaped text inside `error.message`.
const STRUCTURED_ENTITLEMENT = /(?<!\\)"entitlement"\s*:\s*\{/;
const MACHINE_ERROR = /"_tag"\s*:\s*"Error"/;
const URL_IN_TEXT = /https?:\/\/[^\s<>`"'*)\]}]+/gi;

const unique = <T>(values: Iterable<T>) => [...new Set(values)];

const asText = (value: unknown): string =>
  value === undefined || value === null
    ? ''
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);

export function toolOutputText(record: ToolCallRecord): string {
  return stripVTControlCharacters(
    [asText(record.result), asText(record.error)]
      .filter((part) => part.length > 0)
      .join('\n')
  );
}

export function readUpgradeUrls(text: string): string[] {
  const named = unique(
    [HINT_URL, UPGRADE_URL_FIELD].flatMap((pattern) =>
      [...text.matchAll(pattern)].map((match) => match[1])
    )
  );
  return named.length > 0 ? named : unique(text.match(BILLING_URL) ?? []);
}

/** Only tool calls that ran the Supabase CLI count, so a `cat` or `curl` that quotes the denial does not. */
export function findPlanGateDenials(
  toolCalls: readonly ToolCallRecord[],
  invocations: readonly SupabaseInvocation[]
): PlanGateDenial[] {
  const records = commandToolCalls(toolCalls);
  const commands = extractCommands(toolCalls);
  return unique(invocations.map(({ commandIndex }) => commandIndex)).flatMap(
    (index) => {
      const record = records[index];
      const output = toolOutputText(record);
      if (!DENIAL_SIGNAL.test(output)) return [];
      return [
        {
          toolCallIndex: toolCalls.indexOf(record),
          command: commands[index],
          output,
          feature: FEATURE.exec(output)?.[1] ?? null,
          upgradeUrls: readUpgradeUrls(output),
          structuredEntitlement: STRUCTURED_ENTITLEMENT.test(output),
          machineOutput: MACHINE_ERROR.test(output),
        },
      ];
    }
  );
}

export function noDenialNote(hosted: boolean): string {
  const note = 'no Supabase CLI output carried a plan-gate denial';
  return hosted ? note : `${note}; ${NO_HOSTED_PROJECT}`;
}

export function checkPlanGateDenied(
  denials: readonly PlanGateDenial[],
  hosted: boolean
): CheckResult {
  const [first] = denials;
  if (first === undefined) {
    return {
      name: DENIAL_CHECK_NAME,
      passed: false,
      notes: noDenialNote(hosted),
    };
  }
  const details = [
    ...(first.feature === null ? [] : [`feature ${first.feature}`]),
    ...(first.upgradeUrls.length === 0
      ? []
      : [`upgrade link ${first.upgradeUrls.join(', ')}`]),
  ];
  return {
    name: DENIAL_CHECK_NAME,
    passed: true,
    notes: `\`${first.command}\` was denied${details.length > 0 ? ` (${details.join(', ')})` : ''}`,
  };
}

export function normaliseUrl(url: string): string {
  const withoutScheme = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const [path = ''] = withoutScheme.split(/[?#]/);
  const slash = path.indexOf('/');
  const host = (slash === -1 ? path : path.slice(0, slash)).toLowerCase();
  const rest = slash === -1 ? '' : path.slice(slash);
  return `${host}${rest}`.replace(/[/.,;:!?)\]}>'"*_`]+$/, '');
}

export function checkUpgradeLinkPassedOn(
  denial: PlanGateDenial | undefined,
  messages: readonly string[],
  hosted: boolean
): CheckResult {
  const name = LINK_CHECK_NAME;
  if (denial === undefined) {
    return { name, passed: false, notes: noDenialNote(hosted) };
  }
  if (denial.upgradeUrls.length === 0) {
    return { name, passed: false, notes: 'the denial carried no upgrade link' };
  }
  const expected = new Set(denial.upgradeUrls.map(normaliseUrl));
  const given = messages
    .flatMap((message) => message.match(URL_IN_TEXT) ?? [])
    .map(normaliseUrl);
  return given.some((url) => expected.has(url))
    ? {
        name,
        passed: true,
        notes: 'a message after the denial gave the upgrade link',
      }
    : {
        name,
        passed: false,
        notes: `no message after the denial gave the upgrade link ${denial.upgradeUrls.join(' or ')}`,
      };
}
