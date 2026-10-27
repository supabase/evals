import type {
  LocalStackEvalContext,
  ToolCallRecord,
  TranscriptPart,
} from '@supabase-evals/core';
import type { PlanGateDenial } from './denial.js';
import type { ProductionProbe, ProductionState } from './production.js';
import {
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

/** Beta (2.123.0-beta.5) adds the structured `entitlement` object next to the escaped message. */
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
  hasNewTable: boolean;
  tickets: number | null;
  flags?: Partial<Record<Relation, unknown>>;
  counts?: Partial<Record<'history' | 'tickets', unknown>>;
  asStrings?: boolean;
  noRows?: boolean;
  failOn?: 'flags' | 'history' | 'tickets';
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

const RELATION_BY_NAME: Record<string, Relation> = {
  'supabase_migrations.schema_migrations': 'history',
  'public.ticket_tags': 'newTable',
  'public.tickets': 'tickets',
};

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
      : text.includes('schema_migrations')
        ? 'history'
        : text.includes('public.tickets')
          ? 'tickets'
          : undefined;
    if (kind === undefined) throw new Error(`unexpected query: ${sql}`);
    if (db.failOn === kind) throw db.failWith ?? new Error(`boom: ${kind}`);
    if (kind === 'flags') {
      if (db.noRows) return { rows: [] };
      const present: Record<Relation, number> = {
        history: Number(db.hasHistory),
        newTable: Number(db.hasNewTable),
        tickets: Number(db.tickets !== null),
      };
      const row: Record<string, unknown> = {};
      for (const [, name, alias] of text.matchAll(
        /to_regclass\('([^']+)'\)[^,]*?\bas (\w+)/g
      )) {
        const relation = RELATION_BY_NAME[name];
        if (relation === undefined)
          throw new Error(`unexpected relation: ${name}`);
        const override = db.flags?.[relation];
        if (override === MISSING) continue;
        row[alias] =
          relation in (db.flags ?? {}) ? override : num(present[relation]);
      }
      return { rows: [row] };
    }
    const alias = /count\(\*\)(?:::\w+)? as (\w+)/.exec(text)?.[1] ?? 'n';
    if (db.counts && kind in db.counts) {
      return { rows: [{ [alias]: db.counts[kind] }] };
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
        rows: [
          {
            [alias]: num(db.versions.filter((v) => asked.includes(v)).length),
          },
        ],
      };
    }
    if (db.tickets === null) {
      throw new Error('relation "public.tickets" does not exist');
    }
    return { rows: [{ [alias]: num(db.tickets) }] };
  };
  return { hostedQuery, queries };
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
    ...overrides,
  },
});
