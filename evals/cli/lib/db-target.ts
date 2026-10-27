import type { ToolCallRecord } from '@supabase-evals/core';
import { invocationFlag, type SupabaseInvocation } from './cli-invocations.js';

export const CLI_FAILURE_RE =
  /"_tag"\s*:\s*"Error"|Cannot find project ref|Access token not provided|Confirmation required|failed to connect|unknown flag|command not found|unexpected status \d{3}|failed to execute query/i;

const FAILURE_NOTE_LENGTH = 200;

const LOOPBACK_HOSTS = new Set([
  'localhost',
  '0.0.0.0',
  '::1',
  'host.docker.internal',
]);
const LOOPBACK_IPV4_RE = /^127(?:\.\d{1,3}){3}$/;
const VARIABLE_REFERENCE = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;
const LOADS_STATUS_ENV_RE =
  /(?:^|[\s;&|(])(?:eval|source|\.|export)\s+["']?(?:\$\(|<\()[^)]*\bsupabase\b[^)]*\bstatus\b[^)]*(?:-o|--output)(?:\s+|=)["']?env\b/;

/** Whether `flag` is on in `argv`: bare, or `--flag=<v>` with a value other than `''`, `0` or `false`; the last occurrence wins. */
export function booleanFlag(argv: readonly string[], flag: string): boolean {
  let value = false;
  for (const token of argv) {
    if (token === flag) {
      value = true;
    } else if (token.startsWith(`${flag}=`)) {
      value = !['', '0', 'false'].includes(token.slice(flag.length + 1));
    }
  }
  return value;
}

/** Whether `url` points at this machine; a URL that doesn't parse or has a dotless host (a container name) counts as local. */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true;
  }
  const name = host.replace(/^\[|\]$/g, '');
  if (name.includes(':')) return name === '::1';
  return (
    LOOPBACK_HOSTS.has(name) ||
    name.endsWith('.localhost') ||
    LOOPBACK_IPV4_RE.test(name) ||
    !name.includes('.')
  );
}

/** The value of `--remote=<v>`; a bare `--remote` takes no value, so it never reads the next token. */
function remoteValue(argv: readonly string[]): string | undefined {
  const values = argv.filter((token) => token.startsWith('--remote='));
  return values[values.length - 1]?.slice('--remote='.length);
}

function assignedValue(command: string, name: string): string | undefined {
  const assignment = new RegExp(
    `(?:^|[\\s;&|(])(?:export\\s+)?${name}=(?:"([^"]*)"|'([^']*)'|([^\\s;&|)]*))`,
    'g'
  );
  let value: string | undefined;
  for (const match of command.matchAll(assignment)) {
    value = match[1] ?? match[2] ?? match[3];
  }
  return value;
}

// Argv keeps `$VAR` unexpanded: it takes its last literal assignment in the same
// command, and with none it's the remote unless the command loads `supabase status -o env`.
function isLocalUrl(url: string, command: string): boolean {
  const name = VARIABLE_REFERENCE.exec(url)?.[1];
  if (name === undefined) return isLoopbackUrl(url);
  const assigned = assignedValue(command, name);
  if (assigned !== undefined) return isLoopbackUrl(assigned);
  return LOADS_STATUS_ENV_RE.test(command);
}

/** Only `--local` or a loopback `--db-url`/`--remote=<url>`: a bare `db push` or `db dump` targets the linked project on CLI 2.x but the local stack on next. */
export function isExplicitlyLocal(
  inv: SupabaseInvocation,
  command: string
): boolean {
  if (booleanFlag(inv.argv, '--local')) return true;
  const remote = remoteValue(inv.argv);
  return [
    invocationFlag(inv, '--db-url'),
    remote?.includes('://') ? remote : undefined,
  ].some((url) => url !== undefined && isLocalUrl(url, command));
}

/** A piped or `|| true` command exits 0 whatever the CLI did, so its own failure text counts too. */
export function toolCallFailed(
  call: ToolCallRecord | undefined,
  extra?: RegExp
): boolean {
  if (call === undefined) return false;
  const output = typeof call.result === 'string' ? call.result : '';
  return (
    call.error !== undefined ||
    CLI_FAILURE_RE.test(output) ||
    extra?.test(output) === true
  );
}

/** A failed call's output is in `error` with no `result`, and can open with warnings, so both are searched for the failure line. */
export function toolCallFailureLine(
  call: ToolCallRecord | undefined,
  extra?: RegExp
): string | undefined {
  const output = typeof call?.result === 'string' ? call.result : '';
  const line =
    `${output}\n${call?.error ?? ''}`
      .split('\n')
      .find(
        (candidate) =>
          CLI_FAILURE_RE.test(candidate) || extra?.test(candidate) === true
      ) ??
    call?.error?.split('\n').find((candidate) => candidate.trim() !== '');
  return line?.trim().slice(0, FAILURE_NOTE_LENGTH);
}
