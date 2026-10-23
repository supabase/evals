import type { CheckResult } from '@supabase-evals/core';
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

export function countDatabaseCheckRuns(
  invocations: readonly SupabaseInvocation[],
  stackDbUrl?: string
): { lint: number; advisors: number; remote: number } {
  const counts = { lint: 0, advisors: 0, remote: 0 };
  for (const invocation of invocations) {
    if (invocationVerb(invocation) !== 'db') continue;
    const subcommand = invocationSubcommand(invocation);
    if (subcommand !== 'lint' && subcommand !== 'advisors') continue;
    if (invocationPositionals(invocation).includes('help')) continue;
    if (targetsLocalDatabase(invocation, stackDbUrl)) counts[subcommand]++;
    else counts.remote++;
  }
  return counts;
}

export function checkRanDatabaseChecks(counts: {
  lint: number;
  advisors: number;
  remote: number;
}): CheckResult {
  const skipped =
    counts.remote > 0
      ? ` (${counts.remote} remote run${counts.remote === 1 ? '' : 's'} not counted)`
      : '';
  return {
    name: RAN_CHECKS_CHECK,
    passed: counts.lint + counts.advisors > 0,
    notes: `db lint ×${counts.lint}, db advisors ×${counts.advisors}${skipped}`,
  };
}
