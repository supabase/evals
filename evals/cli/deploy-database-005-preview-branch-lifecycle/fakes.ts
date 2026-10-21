import type {
  LocalStackEvalContext,
  ManagementApiClient,
  ToolCallRecord,
} from '@supabase-evals/core';
import { vi } from 'vitest';
import type { BranchSummary } from './branches.js';
import type { ProductionProbe, ProductionState } from './production.js';
import {
  BASELINE_VERSION,
  NEW_MIGRATION_VERSION,
  SEEDED_ORDERS,
} from './seed.js';

export const REF = 'abcdefghijklmnopqrst';
export const BRANCH_REF = 'zyxwvutsrqponmlkjihg';
export const SESSION_START = 1_700_000_000_000;
export const BRANCHES_PATH = '/v1/projects/{ref}/branches';

export const DAY_MS = 86_400_000;

export const iso = (ms: number) => new Date(ms).toISOString();

type HostedQuery = NonNullable<LocalStackEvalContext['hostedQuery']>;

type QueryKind = 'flags' | 'history' | 'orders';

export type FakeProduction = {
  flags?: Record<string, unknown>;
  counts?: Partial<Record<'history' | 'orders', unknown>>;
  hasHistory: boolean;
  versions: string[];
  hasNewTable: boolean;
  orders: number | null;
  asStrings?: boolean;
  noRows?: boolean;
  failOn?: QueryKind;
  failWith?: unknown;
};

export const SEEDED_PRODUCTION: FakeProduction = {
  hasHistory: true,
  versions: [BASELINE_VERSION],
  hasNewTable: false,
  orders: SEEDED_ORDERS,
};

export const PUSHED_PRODUCTION: FakeProduction = {
  ...SEEDED_PRODUCTION,
  versions: [BASELINE_VERSION, NEW_MIGRATION_VERSION],
  hasNewTable: true,
};

function queryKind(sql: string): QueryKind {
  const text = sql.toLowerCase().replace(/\s+/g, ' ');
  if (text.includes('to_regclass')) return 'flags';
  if (text.includes('from supabase_migrations.schema_migrations')) {
    return 'history';
  }
  if (text.includes('from public.orders')) return 'orders';
  throw new Error(`unexpected query: ${sql}`);
}

/** A hostedQuery that answers the production probe's three queries by their SQL text and records every query. */
export function fakeHostedQuery(db: FakeProduction) {
  const queries: string[] = [];
  const num = (value: number) => (db.asStrings ? String(value) : value);
  const hostedQuery: HostedQuery = async (sql) => {
    queries.push(sql);
    const kind = queryKind(sql);
    if (db.failOn === kind) throw db.failWith ?? new Error(`boom: ${kind}`);
    if (kind === 'flags') {
      if (db.flags) return { rows: [db.flags] };
      return db.noRows
        ? { rows: [] }
        : {
            rows: [
              {
                has_history: num(Number(db.hasHistory)),
                has_new_table: num(Number(db.hasNewTable)),
                has_orders: num(Number(db.orders !== null)),
              },
            ],
          };
    }
    if (db.counts && kind in db.counts) {
      return { rows: [{ n: db.counts[kind] }] };
    }
    if (kind === 'history') {
      if (!db.hasHistory) {
        throw new Error(
          'relation "supabase_migrations.schema_migrations" does not exist'
        );
      }
      const asked = [...sql.matchAll(/version\s*=\s*'(\d+)'/g)].map(
        (match) => match[1]
      );
      return {
        rows: [{ n: num(db.versions.filter((v) => asked.includes(v)).length) }],
      };
    }
    if (db.orders === null) {
      throw new Error('relation "public.orders" does not exist');
    }
    return { rows: [{ n: num(db.orders) }] };
  };
  return { hostedQuery, queries };
}

export type ApiBranch = {
  id: string;
  name: string;
  project_ref: string;
  parent_project_ref: string;
  is_default: boolean;
  persistent: boolean;
  status: string;
  created_at?: string;
  updated_at: string;
  with_data: boolean;
  deletion_scheduled_at?: string;
  preview_project_status?: string;
};

export const apiBranch = (overrides: Partial<ApiBranch> = {}): ApiBranch => ({
  id: 'branch-1',
  name: 'preview-shipments',
  project_ref: BRANCH_REF,
  parent_project_ref: REF,
  is_default: false,
  persistent: false,
  status: 'MIGRATIONS_PASSED',
  created_at: iso(SESSION_START + 60_000),
  updated_at: iso(SESSION_START + 60_000),
  with_data: false,
  ...overrides,
});

export const DEFAULT_BRANCH = apiBranch({
  id: 'branch-default',
  name: 'main',
  project_ref: REF,
  is_default: true,
  persistent: true,
  status: 'FUNCTIONS_DEPLOYED',
  created_at: iso(SESSION_START - 30 * DAY_MS),
});

export const OLDER_BRANCH = apiBranch({
  id: 'branch-older',
  name: 'old-feature',
  project_ref: 'mnopqrstuvwxyzabcdef',
  created_at: iso(SESSION_START - DAY_MS),
});

export type FakeMgmt = {
  branches?: ApiBranch[];
  error?: unknown;
  status?: number;
  throws?: string;
};

/** A Management API client whose GET answers only the branches listing. */
export function fakeMgmt(options: FakeMgmt = {}) {
  const GET = vi.fn(async (path: string, _opts?: unknown) => {
    if (options.throws !== undefined) throw new Error(options.throws);
    if (path !== BRANCHES_PATH) throw new Error(`unexpected GET ${path}`);
    if (options.error !== undefined) {
      return {
        data: undefined,
        error: options.error,
        response: { status: options.status ?? 500 },
      };
    }
    return {
      data: options.branches ?? [DEFAULT_BRANCH],
      error: undefined,
      response: { status: 200 },
    };
  });
  return { GET, hostedMgmt: { GET } as unknown as ManagementApiClient };
}

export const summary = (
  overrides: Partial<BranchSummary> = {}
): BranchSummary => ({
  name: 'preview-shipments',
  projectRef: BRANCH_REF,
  isDefault: false,
  status: 'MIGRATIONS_PASSED',
  createdAtMs: SESSION_START + 60_000,
  ...overrides,
});

export const DEFAULT_SUMMARY = summary({
  name: 'main',
  projectRef: REF,
  isDefault: true,
  status: 'FUNCTIONS_DEPLOYED',
  createdAtMs: SESSION_START - 30 * DAY_MS,
});

export const OLDER_SUMMARY = summary({
  name: 'old-feature',
  projectRef: 'mnopqrstuvwxyzabcdef',
  createdAtMs: SESSION_START - DAY_MS,
});

export const shellCall = (
  command: string,
  output: unknown = '',
  error?: string
): ToolCallRecord => ({
  tool: { kind: 'other', toolName: 'shell' },
  body: { command },
  command,
  ts: 0,
  ...(error === undefined ? { result: output } : { error }),
});

export const productionProbe = (
  overrides: Partial<ProductionState> = {}
): ProductionProbe => ({
  ok: true,
  state: {
    newVersionRecorded: false,
    newTablePresent: false,
    ordersPresent: true,
    orderRows: SEEDED_ORDERS,
    ...overrides,
  },
});
