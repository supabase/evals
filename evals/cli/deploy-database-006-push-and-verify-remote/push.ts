import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import {
  type CommandEntry,
  invocationDirectory,
  invocationFlag,
  invocationSubcommand,
  invocationVerb,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { inProjectDir, shellQuote } from '../lib/shell.js';
import { CHANGED_TABLES } from './seed.js';

export type DbPush = {
  order: number;
  dryRun: boolean;
  /** Only `--local` or a loopback `--db-url`: a bare `db push` targets the linked project on CLI 2.x but the local stack on 3.x. */
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
  return (
    host === 'localhost' ||
    host === '[::1]' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host === 'host.docker.internal' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

function isExplicitlyLocal(inv: SupabaseInvocation): boolean {
  if (booleanFlag(inv.argv, '--local')) return true;
  const url = invocationFlag(inv, '--db-url');
  return url !== undefined && isLoopback(url);
}

function queryTarget(inv: SupabaseInvocation): QueryTarget {
  if (isExplicitlyLocal(inv)) return 'local';
  const remote =
    invocationFlag(inv, '--db-url') !== undefined ||
    invocationFlag(inv, '--project-ref') !== undefined ||
    booleanFlag(inv.argv, '--linked') ||
    booleanFlag(inv.argv, '--remote') ||
    inv.argv.some((token) => token.startsWith('--remote='));
  return remote ? 'remote' : 'default';
}

function readQuery(
  inv: SupabaseInvocation,
  order: number,
  entry: CommandEntry | undefined
): DbQuery {
  const base = {
    order,
    target: queryTarget(inv),
    failed: entry?.failed === true,
  };
  const positional = positionals(inv.argv)[2];
  if (positional !== undefined) return { ...base, sql: positional };

  const file = invocationFlag(inv, '-f') ?? invocationFlag(inv, '--file');
  if (file === undefined) return { ...base, sql: entry?.command ?? null };

  const dir = invocationDirectory(inv);
  return { ...base, sql: null, file, ...(dir === undefined ? {} : { dir }) };
}

export function readDbActivity(
  invocations: readonly SupabaseInvocation[],
  entries: readonly CommandEntry[]
): DbActivity {
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
      case 'query':
        activity.queries.push(readQuery(inv, order, entries[inv.commandIndex]));
        break;
    }
  });
  return activity;
}

/** Fills in the SQL of each `db query -f <file>` from the sandbox; a file that can't be read leaves it null. */
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
        return result.ok ? { ...query, sql: result.stdout } : query;
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

export function checkVerifiedAfterPush(activity: DbActivity): CheckResult {
  const name = VERIFY_CHECK_NAME;
  const fail = (notes: string): CheckResult => ({ name, passed: false, notes });

  const pushOrders = activity.pushes
    .filter((push) => !push.dryRun && !push.explicitlyLocal)
    .map((push) => push.order);
  if (pushOrders.length === 0) return fail('no supabase db push ran');

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
