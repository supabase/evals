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
import {
  maskSqlLiteralsAndComments,
  stripSqlComments,
} from '../lib/migrations.js';
import { inProjectDir, shellQuote } from '../lib/shell.js';
import { NO_HOSTED_PROJECT } from './remote.js';
import { CHANGED_TABLES } from './seed.js';

export type DbPush = {
  order: number;
  dryRun: boolean;
  /** Only `--local` or a loopback `--db-url`/`--remote=<url>`: a bare `db push` targets the linked project on CLI 2.x but the local stack on 3.x. */
  explicitlyLocal: boolean;
  yes: boolean;
  failed: boolean;
  /** The first failure line the push's tool call showed, when it failed. */
  failure?: string;
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
  /** The tool call's command text, which stands in for `sql` while no SQL could be isolated. */
  command?: string;
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
  /"_tag"\s*:\s*"Error"|Cannot find project ref|Access token not provided|Confirmation required|failed to connect|unknown flag|command not found|unexpected status \d{3}|failed to execute query/i;
const FAILURE_NOTE_LENGTH = 200;

const WRITE_WORD_RE =
  /\b(?:insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|comment|copy|into|call|do)\b/i;
const READ_STATEMENT_RE =
  /^\s*\(*\s*(?:select|with|table|values|explain|show|begin|start|commit|rollback|end|set)\b/i;
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

/** A piped or `|| true` command exits 0 whatever the CLI did, so its own failure text counts too. */
function callFailed(call: ToolCallRecord | undefined): boolean {
  if (call === undefined) return false;
  const output = typeof call.result === 'string' ? call.result : '';
  return call.error !== undefined || CLI_FAILURE_RE.test(output);
}

function failureLine(call: ToolCallRecord | undefined): string | undefined {
  const output = typeof call?.result === 'string' ? call.result : '';
  const line =
    output.split('\n').find((candidate) => CLI_FAILURE_RE.test(candidate)) ??
    call?.error?.split('\n').find((candidate) => candidate.trim() !== '');
  return line?.trim().slice(0, FAILURE_NOTE_LENGTH);
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
    failed: callFailed(call),
  };
  const withFile = (file: string): DbQuery => {
    const dir = invocationDirectory(inv);
    return {
      ...base,
      sql: null,
      file,
      ...(dir === undefined ? {} : { dir }),
      ...(command === undefined
        ? {}
        : { command: command.split(file).join(' ') }),
    };
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
  if (file !== undefined) return withFile(file);
  return { ...base, sql: null, ...(command === undefined ? {} : { command }) };
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
      case 'push': {
        const call = calls[inv.commandIndex];
        const failed = callFailed(call);
        const failure = failed ? failureLine(call) : undefined;
        activity.pushes.push({
          order,
          dryRun: booleanFlag(inv.argv, '--dry-run'),
          explicitlyLocal: isExplicitlyLocal(inv),
          yes: booleanFlag(inv.argv, '--yes'),
          failed,
          ...(failure === undefined ? {} : { failure }),
        });
        break;
      }
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

/** Fills in the SQL of each query that reads a file from the sandbox; a file that can't be read, or holds no SQL, leaves it null. */
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
        const sql = result.ok ? stripSqlComments(result.stdout) : '';
        return sql.trim() === '' ? query : { ...query, sql };
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

/** Passes for a real push that didn't fail; the history check scores whether it landed. */
export function checkPushed(activity: DbActivity): CheckResult {
  const name = PUSH_CHECK_NAME;
  const real = activity.pushes.filter((push) => !push.dryRun);
  if (real.some((push) => !push.failed)) return { name, passed: true };

  const fail = (notes: string): CheckResult => ({ name, passed: false, notes });
  if (activity.pushes.length === 0) return fail('no supabase db push ran');
  if (real.length === 0) return fail('only supabase db push --dry-run ran');
  const failure = real.find((push) => push.failure !== undefined)?.failure;
  return fail(
    `every non-dry-run supabase db push failed${failure === undefined ? '' : `; first failure: "${failure}"`}`
  );
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

/** The first real push that didn't fail, else the last real push: the point after which a query has to read the hosted database. */
function verifyAnchor(pushes: readonly DbPush[]): number | undefined {
  const real = pushes.filter(isRealPush);
  return (real.find((push) => !push.failed) ?? real[real.length - 1])?.order;
}

function onlyReads(sql: string): boolean {
  const masked = maskSqlLiteralsAndComments(sql);
  const statements = masked
    .split(';')
    .filter((statement) => statement.trim() !== '');
  return (
    statements.length > 0 &&
    statements.every((statement) => READ_STATEMENT_RE.test(statement)) &&
    !WRITE_WORD_RE.test(masked)
  );
}

function readsOnly(query: DbQuery): boolean {
  if (query.sql !== null) return onlyReads(query.sql);
  return query.command !== undefined && !WRITE_WORD_RE.test(query.command);
}

function namesChangedTableIn(query: DbQuery): boolean {
  const text = query.sql ?? query.command;
  return text !== undefined && namesChangedTable(text);
}

export function checkVerifiedAfterPush(
  hosted: boolean,
  activity: DbActivity
): CheckResult {
  const name = VERIFY_CHECK_NAME;
  const fail = (notes: string): CheckResult => ({ name, passed: false, notes });

  if (!hosted) return fail(NO_HOSTED_PROJECT);
  const anchor = verifyAnchor(activity.pushes);
  if (anchor === undefined) {
    return fail(describeSkippedPushes(activity.pushes));
  }

  const after = activity.queries.filter((query) => query.order > anchor);
  if (after.length === 0) {
    return fail('no supabase db query ran after the push');
  }
  const remote = after.filter((query) => query.target === 'remote');
  if (remote.length === 0) {
    return fail(
      'only local or default-target db queries ran after the push, and those read the local database'
    );
  }
  const naming = remote.filter(namesChangedTableIn);
  if (naming.length === 0) {
    return fail(
      'the remote db queries after the push never read plans or profiles'
    );
  }
  const reading = naming.filter(readsOnly);
  if (reading.length === 0) {
    return fail(
      'the remote db queries after the push wrote to plans or profiles but never read them'
    );
  }
  if (reading.every((query) => query.failed)) {
    return fail(
      'every remote db query that read plans or profiles after the push failed'
    );
  }
  return { name, passed: true };
}
