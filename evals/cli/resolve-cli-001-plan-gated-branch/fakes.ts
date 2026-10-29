import type {
  LocalStackEvalContext,
  ManagementApiClient,
  ToolCallRecord,
  TranscriptPart,
} from '@supabase-evals/core';
import { vi } from 'vitest';
import type { PlanGateDenial } from './denial.js';
import type { ProductionProbe, ProductionState } from './production.js';
import {
  BASELINE_COLUMNS,
  BASELINE_VERSION,
  NEW_MIGRATION_VERSION,
  SEEDED_TICKETS,
} from './seed.js';

export const REF = 'abcdefghijklmnopqrst';
export const BILLING_URL = 'https://supabase.com/dashboard/org/acme/billing';
export const FEATURE = 'branching_limit';
const GATE_MESSAGE = "Branching is not available on your organization's plan.";
export const HINT = 'Your organization does not have access to this feature.';
export const CREATE_COMMAND = 'supabase branches create ticket-tags';
export const LIST_COMMAND = 'supabase branches list';

const gateBody = (url: string) =>
  JSON.stringify({
    message: GATE_MESSAGE,
    error: {
      code: 'entitlement_required',
      feature: FEATURE,
      upgrade_url: url,
    },
  });

/** The one-line error object `--output-format json` prints on pinned, stable and next: the 402 body survives only as escaped text in `error.message`. */
const machineError = (
  code: string,
  status: string,
  url: string,
  extra: Record<string, unknown> = {}
) =>
  JSON.stringify({
    _tag: 'Error',
    error: {
      code,
      message: `${status}: ${gateBody(url)}`,
      ...extra,
    },
  });

const CREATE_STATUS = 'unexpected create branch status 402';
const LIST_STATUS = 'unexpected list branches status 402';

export const JSON_DENIAL = machineError(
  'BranchesCreateUnexpectedStatusError',
  CREATE_STATUS,
  BILLING_URL
);

export const JSON_LIST_DENIAL = machineError(
  'BranchesListUnexpectedStatusError',
  LIST_STATUS,
  BILLING_URL
);

/** Beta (2.123.0-beta.7) adds the structured `entitlement` object next to the escaped message. */
export const BETA_JSON_DENIAL = machineError(
  'BranchesCreateUnexpectedStatusError',
  CREATE_STATUS,
  BILLING_URL,
  { entitlement: { feature: FEATURE, upgrade_url: BILLING_URL } }
);

const textDenial = (shownUrl: string) =>
  [
    `${CREATE_STATUS}: ${gateBody(BILLING_URL)}`,
    `${HINT} Upgrade your plan: ${shownUrl}`,
    'Try rerunning the command with --debug to troubleshoot the error.',
  ].join('\n');

export const TEXT_DENIAL = textDenial(BILLING_URL);

export const ANSI_TEXT_DENIAL = textDenial(`\u001b[1m${BILLING_URL}\u001b[22m`);

export const HINT_ONLY = `${HINT} Upgrade your plan: ${BILLING_URL}`;

export const AUTH_FAILURE =
  'Access token not provided. Supply an access token by running supabase login or setting the SUPABASE_ACCESS_TOKEN environment variable.';

export const CREATED_OUTPUT = [
  'Created preview branch:',
  '',
  '  ID                   | NAME      | DEFAULT | STATUS',
  '  zyxwvutsrqponmlkjihg | ticket-tags | false   | CREATING_PROJECT',
  '',
].join('\n');

export const shellCall = (
  command: string,
  output: unknown = ''
): ToolCallRecord => ({
  tool: { kind: 'other', toolName: 'shell' },
  body: { command },
  command,
  ts: 0,
  result: output,
});

/** A shell call that failed: its output is carried in `error`, not `result`. */
export const failedCall = (command: string, error: string): ToolCallRecord => ({
  tool: { kind: 'other', toolName: 'shell' },
  body: { command },
  command,
  ts: 0,
  error,
});

export const deniedCall = (
  command = CREATE_COMMAND,
  error = JSON_DENIAL
): ToolCallRecord => failedCall(command, error);

export const readCall = (path: string): ToolCallRecord => ({
  tool: { kind: 'other', toolName: 'read' },
  body: { path },
  path,
  ts: 0,
  result: 'contents',
});

export type Usage = {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
};

type Meta = {
  requestId?: string;
  usage?: Usage;
  ts?: number;
  resultTs?: number;
};

type Role = 'assistant' | 'user' | 'system';

type Step =
  | ({ say: string; role?: Role } & Meta)
  | ({ call: ToolCallRecord } & Meta);

export const say = (
  content: string,
  meta: Meta & { role?: Role } = {}
): Step => ({
  say: content,
  ...meta,
});

export const tool = (call: ToolCallRecord, meta: Meta = {}): Step => ({
  call,
  ...meta,
});

/** Builds `toolCalls` and `transcript` together, so the i-th tool call is the i-th `tool_call` part, as the CLI agents' adapter produces them. */
export function buildRun(steps: readonly Step[]): {
  toolCalls: ToolCallRecord[];
  transcript: TranscriptPart[];
} {
  const toolCalls: ToolCallRecord[] = [];
  const transcript: TranscriptPart[] = [];
  for (const step of steps) {
    const { requestId, usage, ts, resultTs } = step;
    const tagged = {
      ...(ts === undefined ? {} : { ts }),
      ...(requestId === undefined ? {} : { requestId }),
      ...(usage === undefined ? {} : { usage }),
    };
    if ('say' in step) {
      transcript.push({
        type: 'message',
        role: step.role ?? 'assistant',
        content: step.say,
        ...tagged,
      });
      continue;
    }
    const { call } = step;
    toolCalls.push({
      ...call,
      ts: ts ?? 0,
      ...(resultTs === undefined ? {} : { resultTs }),
    });
    transcript.push({
      type: 'tool_call',
      name: call.tool.toolName,
      input: call.body,
      ...(call.error === undefined
        ? { output: call.result }
        : { error: call.error }),
      ...tagged,
      ...(resultTs === undefined ? {} : { resultTs }),
    });
  }
  return { toolCalls, transcript };
}

export const denial = (
  overrides: Partial<PlanGateDenial> = {}
): PlanGateDenial => ({
  toolCallIndex: 0,
  command: CREATE_COMMAND,
  output: JSON_DENIAL,
  feature: FEATURE,
  upgradeUrls: [BILLING_URL],
  structuredEntitlement: false,
  machineOutput: true,
  ...overrides,
});

type HostedQuery = NonNullable<LocalStackEvalContext['hostedQuery']>;

type Relation = 'history' | 'newTable' | 'tickets';

export const MISSING = Symbol('column omitted from the flags row');

export type FakeProduction = {
  hasHistory: boolean;
  versions: string[];
  /** `public.ticket_tags` exists. */
  hasNewTable: boolean;
  /** Other schemas holding a `ticket_tags` table, system schemas included. */
  newTableIn?: string[];
  tickets: number | null;
  ticketColumns?: string[];
  flags?: Partial<Record<Relation, unknown>>;
  counts?: Partial<Record<'tickets', unknown>>;
  historyRows?: Record<string, unknown>[];
  columnRows?: Record<string, unknown>[];
  asStrings?: boolean;
  noRows?: boolean;
  failOn?: 'flags' | 'history' | 'columns' | 'tickets';
  failWith?: unknown;
};

export const SEEDED_PRODUCTION: FakeProduction = {
  hasHistory: true,
  versions: [BASELINE_VERSION],
  hasNewTable: false,
  tickets: SEEDED_TICKETS,
};

export const PUSHED_PRODUCTION: FakeProduction = {
  ...SEEDED_PRODUCTION,
  versions: [BASELINE_VERSION, NEW_MIGRATION_VERSION],
  hasNewTable: true,
};

const SYSTEM_SCHEMA_EXCLUSIONS: Array<[prefix: string, sqlFragment: string]> = [
  ['pg_catalog', "'pg_catalog'"],
  ['information_schema', "'information_schema'"],
  ['pg_toast', "'pg_toast'"],
  ['pg_temp_', 'pg\\_temp\\_'],
];

/** Whether the lowercased `sql` leaves `schema` out of a catalog search, as it must for a system schema. */
const excludesSchema = (sql: string, schema: string) =>
  SYSTEM_SCHEMA_EXCLUSIONS.some(
    ([prefix, fragment]) => schema.startsWith(prefix) && sql.includes(fragment)
  );

/**
 * A hostedQuery that answers the production probe by what each query reads, not by its column aliases,
 * so it serves any alias the probe picks; it records every query.
 */
export function fakeHostedQuery(db: FakeProduction) {
  const queries: string[] = [];
  const num = (value: number) => (db.asStrings ? String(value) : value);
  const hostedQuery: HostedQuery = async (sql) => {
    queries.push(sql);
    const text = sql.toLowerCase().replace(/\s+/g, ' ');
    const kind = text.includes('to_regclass')
      ? 'flags'
      : text.includes('pg_attribute')
        ? 'columns'
        : text.includes('schema_migrations')
          ? 'history'
          : text.includes('public.tickets')
            ? 'tickets'
            : undefined;
    if (kind === undefined) throw new Error(`unexpected query: ${sql}`);
    if (db.failOn === kind) throw db.failWith ?? new Error(`boom: ${kind}`);
    if (kind === 'flags') {
      if (db.noRows) return { rows: [] };
      const searchesCatalog = text.includes('pg_class');
      const newTableSchemas = [
        ...(db.hasNewTable ? ['public'] : []),
        ...(db.newTableIn ?? []),
      ];
      const present: Record<Relation, number> = {
        history: Number(db.hasHistory),
        newTable: Number(
          searchesCatalog
            ? newTableSchemas.some((schema) => !excludesSchema(text, schema))
            : db.hasNewTable
        ),
        tickets: Number(db.tickets !== null),
      };
      const row: Record<string, unknown> = {};
      let from = 0;
      for (const match of text.matchAll(/\bas (\w+)/g)) {
        const expression = text.slice(from, match.index);
        from = match.index + match[0].length;
        const relation = expression.includes('schema_migrations')
          ? 'history'
          : expression.includes('ticket_tags')
            ? 'newTable'
            : expression.includes('public.tickets')
              ? 'tickets'
              : undefined;
        if (relation === undefined) {
          throw new Error(`unexpected flag expression: ${expression}`);
        }
        const override = db.flags?.[relation];
        if (override === MISSING) continue;
        row[match[1]] =
          relation in (db.flags ?? {}) ? override : num(present[relation]);
      }
      return { rows: [row] };
    }
    if (kind === 'history') {
      if (!db.hasHistory) {
        throw new Error(
          'relation "supabase_migrations.schema_migrations" does not exist'
        );
      }
      return {
        rows: db.historyRows ?? db.versions.map((version) => ({ version })),
      };
    }
    if (kind === 'columns') {
      return {
        rows:
          db.columnRows ??
          (db.ticketColumns ?? BASELINE_COLUMNS).map((column_name) => ({
            column_name,
          })),
      };
    }
    const alias = /count\(\*\)(?:::\w+)? as (\w+)/.exec(text)?.[1] ?? 'n';
    if (db.counts && kind in db.counts) {
      return { rows: [{ [alias]: db.counts[kind] }] };
    }
    if (db.tickets === null) {
      throw new Error('relation "public.tickets" does not exist');
    }
    return { rows: [{ [alias]: num(db.tickets) }] };
  };
  return { hostedQuery, queries };
}

export const BRANCHES_PATH = '/v1/projects/{ref}/branches';
export const API_KEYS_PATH = '/v1/projects/{ref}/api-keys';

type ApiBranch = { name: string; is_default: boolean };

export const DEFAULT_BRANCH: ApiBranch = { name: 'main', is_default: true };

export const previewBranch = (name = 'ticket-tags'): ApiBranch => ({
  name,
  is_default: false,
});

export type FakeMgmt = {
  branches?: ApiBranch[];
  branchesError?: unknown;
  branchesStatus?: number;
  branchesThrow?: string;
  apiKeys?: Array<{ name: string; api_key?: string | null }>;
  apiKeysThrow?: string;
};

/** A Management API client whose GET answers the branch listing and the project's API keys. */
export function fakeMgmt(options: FakeMgmt = {}) {
  const GET = vi.fn(async (path: string, _opts?: unknown) => {
    if (path === API_KEYS_PATH) {
      if (options.apiKeysThrow !== undefined) {
        throw new Error(options.apiKeysThrow);
      }
      return {
        data: options.apiKeys ?? [],
        error: undefined,
        response: { status: 200 },
      };
    }
    if (path !== BRANCHES_PATH) throw new Error(`unexpected GET ${path}`);
    if (options.branchesThrow !== undefined) {
      throw new Error(options.branchesThrow);
    }
    if (options.branchesError !== undefined) {
      return {
        data: undefined,
        error: options.branchesError,
        response: { status: options.branchesStatus ?? 500 },
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

export const productionProbe = (
  overrides: Partial<ProductionState> = {}
): ProductionProbe => ({
  ok: true,
  state: {
    newVersionRecorded: false,
    newTablePresent: false,
    ticketsPresent: true,
    ticketRows: SEEDED_TICKETS,
    historyVersions: [BASELINE_VERSION],
    ticketColumns: [...BASELINE_COLUMNS],
    ...overrides,
  },
});
