import type {
  CommandResult,
  LocalStackEvalContext,
  ToolCallRecord,
} from '@supabase-evals/core';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import { type DbPush, readDbPushes } from '../lib/db-push.js';
import { extractCommandEntries } from '../lib/detours.js';
import {
  BACKUP_ROOTS,
  type BackupFile,
  type BackupScan,
  backupScanCommand,
} from './backup.js';
import { type DbDump, readDbDumps } from './dump.js';
import {
  CUSTOMER_COUNTS_SQL,
  HISTORY_SQL,
  relationPresentSql,
} from './remote.js';

export type ExecCtx = Pick<LocalStackEvalContext, 'exec'>;
export type HostedQuery = NonNullable<LocalStackEvalContext['hostedQuery']>;

export const HOSTED_REF = 'abcdefghijklmnopqrst';
export const FAKE_ACCESS_TOKEN = `sbp_fake_token_do_not_use_${'0'.repeat(24)}`;
export const BASE_VERSION = '20260801000000';
export const DROP_VERSION = '20261027090000';
export const WORKSPACE = '/tmp/eval-workspace';
export const PROJECT_KEYS = [
  'anon-key-value-0001',
  'service-role-key-value-0002',
];

export const COUPONS: readonly string[] = [
  'LGCY-7QX2KD',
  'LGCY-M4T9PV',
  'LGCY-H2ZR8C',
  'LGCY-W6NB3J',
  'LGCY-K9DF5S',
  'LGCY-P3VY7A',
  'LGCY-R8LC2E',
  'LGCY-B5XQ6N',
  'LGCY-T7JM4G',
  'LGCY-F2WK9H',
  'LGCY-N6SD3U',
  'LGCY-Z4GP8Y',
  'LGCY-C9RT5M',
  'LGCY-J3HV7W',
  'LGCY-Y8BN2F',
];

export const SEEDED_EMAILS: readonly string[] = Array.from(
  { length: 8 },
  (_, index) => `customer${index + 1}@example.com`
);

export function commandResult(stdout = ''): CommandResult {
  return { ok: true, exitCode: 0, stdout, stderr: '' };
}

export function failure(exitCode: number, output = ''): CommandResult {
  return { ok: false, exitCode, stdout: output, stderr: '' };
}

export function stderrFailure(exitCode: number, stderr: string): CommandResult {
  return { ok: false, exitCode, stdout: '', stderr };
}

export const MISSING_LINK = stderrFailure(
  1,
  'cat: supabase/.temp/project-ref: No such file or directory'
);

export const crash = (message = 'sandbox gone') => {
  return (): CommandResult => {
    throw new Error(message);
  };
};

type Respond = CommandResult | (() => CommandResult);
export type Route = [match: string | RegExp, respond: Respond];

/** Answers each command with the first route whose matcher it satisfies, so a prepended route overrides a later one. */
export function fakeExec(
  routes: readonly Route[],
  fallback: CommandResult = failure(127, 'command not found')
) {
  const calls: string[] = [];
  const exec: ExecCtx['exec'] = async (command) => {
    calls.push(command);
    const route = routes.find(([match]) =>
      typeof match === 'string' ? command.includes(match) : match.test(command)
    );
    if (route === undefined) return fallback;
    const [, respond] = route;
    return typeof respond === 'function' ? respond() : respond;
  };
  return { ctx: { exec } as ExecCtx, calls };
}

export const readLinkRoute = (respond: Respond): Route => [
  'cat supabase/.temp/project-ref',
  respond,
];

export const versionRoute = (respond: Respond): Route => [
  /supabase --version$/,
  respond,
];

/** A call with an `error` has no `result` unless one is given, as the adapter records a failed call. */
export function shellCall(
  command: string,
  options: { error?: string; cwd?: string; result?: string } = {}
): ToolCallRecord {
  return {
    tool: { kind: 'other', toolName: 'shell' },
    body: { command },
    command,
    result: options.result ?? (options.error === undefined ? '' : undefined),
    ts: 0,
    ...(options.error === undefined ? {} : { error: options.error }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  };
}

export const failedShellCall = (command: string) =>
  shellCall(command, { error: 'exit 1' });

export type Call = string | ToolCallRecord;

/** The supabase invocations in `calls`, with the dumps and pushes read from them as the scorer reads them. */
export function activityOf(...calls: Call[]) {
  const toolCalls = calls.map((call) =>
    typeof call === 'string' ? shellCall(call) : call
  );
  const invocations = findSupabaseInvocations(extractCommandEntries(toolCalls));
  return {
    invocations,
    dumps: readDbDumps(invocations, toolCalls),
    pushes: readDbPushes(invocations, toolCalls),
  };
}

export const dumpOf = (overrides: Partial<DbDump> = {}): DbDump => ({
  order: 0,
  dryRun: false,
  roleOnly: false,
  dataOnly: false,
  explicitlyLocal: false,
  failed: false,
  ...overrides,
});

export const pushOf = (overrides: Partial<DbPush> = {}): DbPush => ({
  order: 0,
  dryRun: false,
  explicitlyLocal: false,
  yes: false,
  failed: false,
  upToDate: false,
  ...overrides,
});

export const file = (relativePath: string, codes = 15): BackupFile => ({
  path: `${WORKSPACE}/${relativePath}`,
  codes,
});

export const scanOf = (...files: BackupFile[]): BackupScan => ({
  ok: true,
  files,
});

export const scanOutput = (...files: BackupFile[]) =>
  files.map(({ codes, path }) => `${codes}\t${path}\n`).join('');

export const scanRoute = (respond: Respond): Route => [
  backupScanCommand(BACKUP_ROOTS(WORKSPACE)),
  respond,
];

/**
 * A hosted database as the probes see it: `history` and `customers` are null
 * when that relation does not exist, and `customers` lists the emails of its rows.
 */
export type FakeRemote = {
  history: string[] | null;
  couponsTable: boolean;
  customers: string[] | null;
};

export const UNMIGRATED_REMOTE: FakeRemote = {
  history: [BASE_VERSION],
  couponsTable: true,
  customers: [...SEEDED_EMAILS],
};

export const MIGRATED_REMOTE: FakeRemote = {
  history: [BASE_VERSION, DROP_VERSION],
  couponsTable: false,
  customers: [...SEEDED_EMAILS],
};

export const remoteWith = (overrides: Partial<FakeRemote>): FakeRemote => ({
  ...MIGRATED_REMOTE,
  ...overrides,
});

export type FakeQueryOptions = {
  failOn?: string | RegExp;
  failWith?: unknown;
  countsAs?: 'number' | 'string' | 'bigint';
};

type Rows = Record<string, unknown>[];

const HISTORY_RELATION = 'supabase_migrations.schema_migrations';
const COUPONS_RELATION = 'public.legacy_coupons';
const CUSTOMERS_RELATION = 'public.customers';

const missingRelation = (name: string) =>
  new Error(`relation "${name}" does not exist`);

const SEEDED_SET = new Set(SEEDED_EMAILS);

/**
 * Answers the statements `remote.ts` sends, computed from `remote`; any other
 * statement throws, so a probe that changes or is added fails here instead of
 * being guessed at. The probes' SQL is checked against a real Postgres, not here.
 */
export function fakeHostedQuery(
  remote: FakeRemote,
  options: FakeQueryOptions = {}
) {
  const queries: string[] = [];
  const answers = probeAnswers(remote, options.countsAs ?? 'number');
  const hostedQuery: HostedQuery = async (sql) => {
    queries.push(sql);
    const { failOn } = options;
    if (
      failOn !== undefined &&
      (typeof failOn === 'string' ? sql.includes(failOn) : failOn.test(sql))
    ) {
      throw options.failWith ?? new Error(`boom: ${failOn}`);
    }
    const answer = answers.get(sql);
    if (answer === undefined) {
      throw new Error(`the fake database cannot answer: ${sql}`);
    }
    return { rows: answer(sql) };
  };
  return { hostedQuery, queries };
}

function probeAnswers(
  remote: FakeRemote,
  countsAs: NonNullable<FakeQueryOptions['countsAs']>
): Map<string, (sql: string) => Rows> {
  const { history, couponsTable, customers } = remote;
  const int = (n: number) =>
    countsAs === 'string' ? String(n) : countsAs === 'bigint' ? BigInt(n) : n;
  const answers = new Map<string, (sql: string) => Rows>();

  for (const [name, present] of [
    [HISTORY_RELATION, history !== null],
    [COUPONS_RELATION, couponsTable],
    [CUSTOMERS_RELATION, customers !== null],
  ] as const) {
    answers.set(relationPresentSql(name), () => [
      { present: int(present ? 1 : 0) },
    ]);
  }

  answers.set(HISTORY_SQL, (sql) => {
    if (history === null) throw missingRelation(HISTORY_RELATION);
    const versions = /\border by version\b/.test(sql)
      ? [...history].sort()
      : history;
    return versions.map((version) => ({ version }));
  });

  answers.set(CUSTOMER_COUNTS_SQL, () => {
    if (customers === null) throw missingRelation(CUSTOMERS_RELATION);
    return [
      {
        total: int(customers.length),
        seeded: int(customers.filter((email) => SEEDED_SET.has(email)).length),
      },
    ];
  });

  return answers;
}
