import type {
  CheckResult,
  LocalStackEvalContext,
  ToolCallRecord,
} from '@supabase-evals/core';
import {
  findSupabaseInvocations,
  invocationDirectory,
  invocationFlag,
  invocationSubcommand,
  invocationVerb,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import {
  commandToolCalls,
  extractCommandEntries,
  scopedCommandSegments,
  tryShellQuoteParse,
} from '../lib/detours.js';
import { stripSqlComments } from '../lib/migrations.js';
import { inProjectDir, shellQuote } from '../lib/shell.js';
import { NO_HOSTED_PROJECT } from './remote.js';
import { CHANGED_TABLES } from './seed.js';

export type DbPush = {
  order: number;
  dryRun: boolean;
  /** Only `--local` or a loopback `--db-url`/`--remote=<url>`: a bare `db push` targets the linked project on CLI 2.x but the local stack on 3.x. */
  explicitlyLocal: boolean;
  yes: boolean;
};

/** `default` is no target flag: `db query` reads the local database on every CLI channel. */
export type QueryTarget = 'remote' | 'local' | 'default';

export type DbQuery = {
  order: number;
  target: QueryTarget;
  sql: string | null;
  file?: string;
  dir?: string;
  failed: boolean;
};

export type DbActivity = { pushes: DbPush[]; queries: DbQuery[] };

export const PUSH_CHECK_NAME = 'the agent pushed with supabase db push';
export const VERIFY_CHECK_NAME =
  'the agent checked the hosted project with supabase db query after pushing';

// `--remote` is absent: it takes its optional value only as `--remote=<v>`.
const QUERY_VALUE_FLAGS = new Set([
  '--db-url',
  '--project-ref',
  '--file',
  '-f',
  '--workdir',
  '--profile',
  '-o',
  '--output',
  '--output-format',
  '--network-id',
  '--dns-resolver',
  '--log-level',
  '--agent',
]);

const STDIN_FILES = new Set(['-', '/dev/stdin']);
const CAT_SUBSTITUTION = /^\$\(\s*cat\s+([^\s'"`$()]+)\s*\)$/;
const CLI_FAILURE_RE =
  /"_tag"\s*:\s*"Error"|Cannot find project ref|Access token not provided|Confirmation required|failed to connect|unknown flag|command not found/i;
const LOOPBACK_HOSTS = new Set([
  'localhost',
  '0.0.0.0',
  '::1',
  'host.docker.internal',
]);
const LOOPBACK_IPV4_RE = /^127(?:\.\d{1,3}){3}$/;

const CHANGED_TABLE = new RegExp(
  `(?<![A-Za-z0-9_$])(?:${CHANGED_TABLES.join('|')})(?![A-Za-z0-9_$])`,
  'i'
);

function positionals(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('-')) {
      if (!token.includes('=') && QUERY_VALUE_FLAGS.has(token)) i++;
      continue;
    }
    out.push(token);
  }
  return out;
}

function booleanFlag(argv: readonly string[], flag: string): boolean {
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

function isLoopback(url: string): boolean {
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

function isExplicitlyLocal(inv: SupabaseInvocation): boolean {
  if (booleanFlag(inv.argv, '--local')) return true;
  const remote = remoteValue(inv.argv);
  return [
    invocationFlag(inv, '--db-url'),
    remote?.includes('://') ? remote : undefined,
  ].some((url) => url !== undefined && isLoopback(url));
}

function queryTarget(inv: SupabaseInvocation): QueryTarget {
  if (isExplicitlyLocal(inv)) return 'local';
  const remote =
    invocationFlag(inv, '--db-url') !== undefined ||
    invocationFlag(inv, '--project-ref') !== undefined ||
    booleanFlag(inv.argv, '--linked') ||
    booleanFlag(inv.argv, '--remote') ||
    remoteValue(inv.argv) !== undefined;
  return remote ? 'remote' : 'default';
}

/** A piped or `|| true` query exits 0 whatever the CLI did, so its own failure text counts too. */
function queryFailed(call: ToolCallRecord | undefined): boolean {
  if (call === undefined) return false;
  const output = typeof call.result === 'string' ? call.result : '';
  return call.error !== undefined || CLI_FAILURE_RE.test(output);
}

function redirectedFile(segment: string): string | undefined {
  const tokens = tryShellQuoteParse(segment) ?? [];
  const at = tokens.findIndex(
    (token) => typeof token === 'object' && 'op' in token && token.op === '<'
  );
  const target = tokens[at + 1];
  return at !== -1 && typeof target === 'string' ? target : undefined;
}

function catOperand(segment: string): string | undefined {
  const [word, file, ...rest] = tryShellQuoteParse(segment) ?? [];
  return word === 'cat' &&
    typeof file === 'string' &&
    !file.startsWith('-') &&
    rest.length === 0
    ? file
    : undefined;
}

/** The file a query reads its SQL from by redirect (`< f`) or pipe (`cat f |`); `ordinal` is its place among the supabase invocations of `command`. */
function stdinFile(command: string, ordinal: number): string | undefined {
  const segments = scopedCommandSegments(command).map(({ segment }) => segment);
  const at = segments.flatMap((segment, i) =>
    findSupabaseInvocations([segment]).length > 0 ? [i] : []
  )[ordinal];
  if (at === undefined) return undefined;
  return (
    redirectedFile(segments[at]) ??
    (at > 0 ? catOperand(segments[at - 1]) : undefined)
  );
}

function sqlFile(
  inv: SupabaseInvocation,
  command: string,
  ordinal: number
): string | undefined {
  const flagged = invocationFlag(inv, '-f') ?? invocationFlag(inv, '--file');
  if (flagged !== undefined && !STDIN_FILES.has(flagged)) return flagged;
  return stdinFile(command, ordinal);
}

function readQuery(
  inv: SupabaseInvocation,
  order: number,
  ordinal: number,
  command: string | undefined,
  call: ToolCallRecord | undefined
): DbQuery {
  const base = {
    order,
    target: queryTarget(inv),
    failed: queryFailed(call),
  };
  const withFile = (file: string): DbQuery => {
    const dir = invocationDirectory(inv);
    return { ...base, sql: null, file, ...(dir === undefined ? {} : { dir }) };
  };

  const positional = positionals(inv.argv)[2];
  if (positional !== undefined) {
    const catted = CAT_SUBSTITUTION.exec(positional)?.[1];
    return catted === undefined
      ? { ...base, sql: stripSqlComments(positional) }
      : withFile(catted);
  }

  const file =
    command === undefined ? undefined : sqlFile(inv, command, ordinal);
  return file === undefined
    ? { ...base, sql: command ?? null }
    : withFile(file);
}

export function readDbActivity(
  invocations: readonly SupabaseInvocation[],
  toolCalls: readonly ToolCallRecord[]
): DbActivity {
  const entries = extractCommandEntries(toolCalls);
  const calls = commandToolCalls(toolCalls);
  const activity: DbActivity = { pushes: [], queries: [] };
  invocations.forEach((inv, order) => {
    if (invocationVerb(inv) !== 'db') return;
    switch (invocationSubcommand(inv)) {
      case 'push':
        activity.pushes.push({
          order,
          dryRun: booleanFlag(inv.argv, '--dry-run'),
          explicitlyLocal: isExplicitlyLocal(inv),
          yes: booleanFlag(inv.argv, '--yes'),
        });
        break;
      case 'query': {
        const first = invocations.findIndex(
          (other) => other.commandIndex === inv.commandIndex
        );
        activity.queries.push(
          readQuery(
            inv,
            order,
            order - first,
            entries[inv.commandIndex]?.command,
            calls[inv.commandIndex]
          )
        );
        break;
      }
    }
  });
  return activity;
}

/** Fills in the SQL of each query that reads a file from the sandbox; a file that can't be read leaves it null. */
export async function readQueryFiles(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  activity: DbActivity
): Promise<DbActivity> {
  const queries = await Promise.all(
    activity.queries.map(async (query) => {
      if (query.file === undefined || query.sql !== null) return query;
      try {
        const result = await ctx.exec(
          inProjectDir(query.dir, `cat ${shellQuote(query.file)}`)
        );
        return result.ok
          ? { ...query, sql: stripSqlComments(result.stdout) }
          : query;
      } catch {
        return query;
      }
    })
  );
  return { pushes: activity.pushes, queries };
}

export function namesChangedTable(sql: string): boolean {
  return CHANGED_TABLE.test(sql);
}

/** Counts a push that errored; the history check scores whether it landed. */
export function checkPushed(activity: DbActivity): CheckResult {
  const name = PUSH_CHECK_NAME;
  if (activity.pushes.some((push) => !push.dryRun)) {
    return { name, passed: true };
  }
  return {
    name,
    passed: false,
    notes:
      activity.pushes.length > 0
        ? 'only supabase db push --dry-run ran'
        : 'no supabase db push ran',
  };
}

/** A push that isn't a dry run and isn't explicitly local. */
export function isRealPush(push: DbPush): boolean {
  return !push.dryRun && !push.explicitlyLocal;
}

function describeSkippedPushes(pushes: readonly DbPush[]): string {
  if (pushes.length === 0) return 'no supabase db push ran';
  const kinds = [
    ...(pushes.some((push) => push.dryRun) ? ['dry-run'] : []),
    ...(pushes.some((push) => !push.dryRun) ? ['local'] : []),
  ];
  return `only ${kinds.join(' and ')} supabase db push ran`;
}

export function checkVerifiedAfterPush(
  hosted: boolean,
  activity: DbActivity
): CheckResult {
  const name = VERIFY_CHECK_NAME;
  const fail = (notes: string): CheckResult => ({ name, passed: false, notes });

  if (!hosted) return fail(NO_HOSTED_PROJECT);
  const pushOrders = activity.pushes
    .filter(isRealPush)
    .map((push) => push.order);
  if (pushOrders.length === 0) {
    return fail(describeSkippedPushes(activity.pushes));
  }

  const lastPush = Math.max(...pushOrders);
  const after = activity.queries.filter((query) => query.order > lastPush);
  if (after.length === 0) {
    return fail('no supabase db query ran after the push');
  }
  const remote = after.filter((query) => query.target === 'remote');
  if (remote.length === 0) {
    return fail(
      'only local or default-target db queries ran after the push, and those read the local database'
    );
  }
  const reading = remote.filter(
    (query) => query.sql !== null && namesChangedTable(query.sql)
  );
  if (reading.length === 0) {
    return fail(
      'the remote db queries after the push never read plans or profiles'
    );
  }
  if (reading.every((query) => query.failed)) {
    return fail(
      'every remote db query that read plans or profiles after the push failed'
    );
  }
  return { name, passed: true };
}
