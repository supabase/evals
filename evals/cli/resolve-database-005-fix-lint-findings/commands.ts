import type { CheckResult, ToolCallRecord } from '@supabase-evals/core';
import {
  invocationFlag,
  invocationPositionals,
  invocationSubcommand,
  invocationVerb,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { urlPort } from '../lib/stack.js';

export const RAN_CHECKS_CHECK = 'ran supabase db lint or db advisors';

const DEFAULT_POSTGRES_PORT = 5432;
const REMOTE_FLAGS = ['--linked', '--project-ref'];
const LOOPBACK_HOSTS = new Set([
  'localhost',
  '0.0.0.0',
  '::1',
  'host.docker.internal',
]);
const LOOPBACK_IPV4_RE = /^127(?:\.\d{1,3}){3}$/;
const SHELL_EXPANSION_RE = /[$`]/;
const URL_AUTHORITY_RE =
  /^[a-z][a-z\d+.-]*:\/\/(?:[^/?#]*@)?(\[[^\]]*\]|[^/?#:@]*)(?::([^/?#]*))?/i;
const CHECK_OUTPUT_RE =
  /"results"\s*:|No issues found|No schema errors found|Linting schema:/;
const CLI_FAILURE_RE =
  /"_tag"\s*:\s*"(?:Error|Help)"|failed to connect|command not found|unknown flag|unknown command|invalid argument/i;

const hasFlag = (invocation: SupabaseInvocation, flag: string) =>
  invocation.argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`));

function isLoopbackHost(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (name.includes(':')) return name === '::1';
  return (
    LOOPBACK_HOSTS.has(name) ||
    name.endsWith('.localhost') ||
    LOOPBACK_IPV4_RE.test(name) ||
    !name.includes('.')
  );
}

function isLocalDbUrl(dbUrl: string, stackDbUrl: string | undefined): boolean {
  const match = URL_AUTHORITY_RE.exec(dbUrl);
  if (match === null) return SHELL_EXPANSION_RE.test(dbUrl);
  const [, host, port = ''] = match;
  // A host or port still holding a shell expansion can't be read, so it gets the benefit of the doubt.
  const hostIsLocal = SHELL_EXPANSION_RE.test(host) || isLoopbackHost(host);
  const portMatches =
    stackDbUrl === undefined ||
    SHELL_EXPANSION_RE.test(port) ||
    (port === '' ? DEFAULT_POSTGRES_PORT : Number(port)) ===
      (urlPort(stackDbUrl) ?? DEFAULT_POSTGRES_PORT);
  return hostIsLocal && portMatches;
}

/** Whether the invocation runs against the local database: no target flag, `--local`, or a loopback `--db-url` (or `--remote=<url>`) on the stack's port. */
export function targetsLocalDatabase(
  invocation: SupabaseInvocation,
  stackDbUrl?: string
): boolean {
  if (REMOTE_FLAGS.some((flag) => hasFlag(invocation, flag))) return false;
  if (invocation.argv.includes('--remote')) return false;
  const remote = invocationFlag(invocation, '--remote');
  if (remote !== undefined && !remote.includes('://')) return false;
  return [remote, invocationFlag(invocation, '--db-url')].every(
    (dbUrl) => dbUrl === undefined || isLocalDbUrl(dbUrl, stackDbUrl)
  );
}

/** Whether a check's tool call shows it failed before checking anything. */
export function checkRunFailed(call: ToolCallRecord | undefined): boolean {
  if (call === undefined) return false;
  const output =
    (typeof call.result === 'string' ? call.result : '') + (call.error ?? '');
  // `--fail-on` exits non-zero when it finds something, so results in the output mean the check ran.
  if (CHECK_OUTPUT_RE.test(output)) return false;
  if (CLI_FAILURE_RE.test(output)) return true;
  // A blank errored output (e.g. redirected to a file) gets the benefit of the doubt.
  return call.error !== undefined && output.trim() !== '';
}

export function countDatabaseCheckRuns(
  invocations: readonly SupabaseInvocation[],
  stackDbUrl?: string,
  calls?: readonly ToolCallRecord[]
): { lint: number; advisors: number; remote: number; failed: number } {
  const counts = { lint: 0, advisors: 0, remote: 0, failed: 0 };
  for (const invocation of invocations) {
    if (invocationVerb(invocation) !== 'db') continue;
    const subcommand = invocationSubcommand(invocation);
    if (subcommand !== 'lint' && subcommand !== 'advisors') continue;
    if (invocationPositionals(invocation).includes('help')) continue;
    if (!targetsLocalDatabase(invocation, stackDbUrl)) counts.remote++;
    else if (checkRunFailed(calls?.[invocation.commandIndex])) counts.failed++;
    else counts[subcommand]++;
  }
  return counts;
}

export function checkRanDatabaseChecks(counts: {
  lint: number;
  advisors: number;
  remote: number;
  failed: number;
}): CheckResult {
  const plural = (n: number) => (n === 1 ? '' : 's');
  const parts = [
    ...(counts.remote > 0
      ? [`${counts.remote} remote run${plural(counts.remote)}`]
      : []),
    ...(counts.failed > 0
      ? [`${counts.failed} failed run${plural(counts.failed)}`]
      : []),
  ];
  const skipped = parts.length > 0 ? ` (${parts.join(', ')} not counted)` : '';
  return {
    name: RAN_CHECKS_CHECK,
    passed: counts.lint + counts.advisors > 0,
    notes: `db lint ×${counts.lint}, db advisors ×${counts.advisors}${skipped}`,
  };
}
