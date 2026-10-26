import type {
  CommandResult,
  LocalStackEvalContext,
  ToolCallRecord,
} from '@supabase-evals/core';

export type ExecCtx = Pick<LocalStackEvalContext, 'exec'>;
export type HostedQuery = NonNullable<LocalStackEvalContext['hostedQuery']>;

export const HOSTED_REF = 'abcdefghijklmnopqrst';
export const FAKE_ACCESS_TOKEN = `sbp_fake_token_do_not_use_${'0'.repeat(24)}`;
export const BASE_VERSION = '20260901000000';
export const PLANS_VERSION = '20261020120000';
export const PROJECT_KEYS = [
  'anon-key-value-0001',
  'service-role-key-value-0002',
];

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

export function shellCall(
  command: string,
  options: { error?: string; cwd?: string; result?: string } = {}
): ToolCallRecord {
  return {
    tool: { kind: 'other', toolName: 'shell' },
    body: { command },
    command,
    result: options.result ?? '',
    ts: 0,
    ...(options.error === undefined ? {} : { error: options.error }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  };
}

export const failedShellCall = (command: string) =>
  shellCall(command, { error: 'exit 1' });

export type SeededUser = { username: string; isPaid: boolean };
export type FakeProfile = SeededUser & { planId: string | null };

/** The 24 users `remote/project.sql` seeds: user_1..user_24, every fourth one paid. */
export const SEEDED_USERS: readonly SeededUser[] = Array.from(
  { length: 24 },
  (_, index) => ({
    username: `user_${index + 1}`,
    isPaid: (index + 1) % 4 === 0,
  })
);

export const PROFILE_COLUMNS_BEFORE = [
  'id',
  'username',
  'is_paid',
  'created_at',
];
export const PROFILE_COLUMNS_AFTER = [...PROFILE_COLUMNS_BEFORE, 'plan_id'];
export const PLANS_COLUMNS = ['id', 'name', 'monthly_price_cents'];

export const rightPlan = (user: SeededUser) => (user.isPaid ? 'pro' : 'free');

export const profilesOf = (
  planFor: (user: SeededUser) => string | null = rightPlan
): FakeProfile[] =>
  SEEDED_USERS.map((user) => ({ ...user, planId: planFor(user) }));

/**
 * A hosted database as the probes see it. `history`, `plans` and `profiles` are
 * null when that relation does not exist; `planId` describes the constraints on
 * `public.profiles.plan_id` when that column is listed in `profiles.columns`.
 */
export type FakeRemote = {
  history: string[] | null;
  plans: { columns: string[]; ids: string[] } | null;
  profiles: { columns: string[]; rows: FakeProfile[] } | null;
  planId: { nullable: boolean; fkTarget: string | null };
};

export const UNMIGRATED_REMOTE: FakeRemote = {
  history: [BASE_VERSION],
  plans: null,
  profiles: {
    columns: PROFILE_COLUMNS_BEFORE,
    rows: profilesOf(() => null),
  },
  planId: { nullable: true, fkTarget: null },
};

export const MIGRATED_REMOTE: FakeRemote = {
  history: [BASE_VERSION, PLANS_VERSION],
  plans: { columns: PLANS_COLUMNS, ids: ['free', 'pro'] },
  profiles: { columns: PROFILE_COLUMNS_AFTER, rows: profilesOf() },
  planId: { nullable: false, fkTarget: 'plans' },
};

export const remoteWith = (overrides: Partial<FakeRemote>): FakeRemote => ({
  ...MIGRATED_REMOTE,
  ...overrides,
});

export const migratedProfiles = (
  planFor?: (user: SeededUser) => string | null
) => ({ columns: PROFILE_COLUMNS_AFTER, rows: profilesOf(planFor) });

export type FakeQueryOptions = {
  failOn?: string | RegExp;
  failWith?: unknown;
  countsAs?: 'number' | 'string' | 'bigint';
};

/*
 * Answers read-only SQL by what it references and throws on anything it cannot
 * place or that names a relation or column the remote lacks. Understood:
 * `to_regclass('<rel>')` (`is [not] null`, `::int`), `schema_migrations`,
 * `information_schema.columns|tables` filtered by `table_name = '<t>'` and
 * `column_name = '<c>'`, foreign-key lookups (`pg_constraint` and the
 * `*_constraint_usage` views; a query that never names `plans` sees any key),
 * `public.plans`, and `public.profiles` (plain columns, or `count(*)` items with
 * `filter (where ...)` over is_paid, plan_id, `is distinct from`, or username
 * via `~`, `in`, `= any` or `generate_series`). Uncast counts follow `countsAs`.
 */
export function fakeHostedQuery(
  remote: FakeRemote,
  options: FakeQueryOptions = {}
) {
  const queries: string[] = [];
  const hostedQuery: HostedQuery = async (sql) => {
    queries.push(sql);
    const { failOn } = options;
    if (
      failOn !== undefined &&
      (typeof failOn === 'string' ? sql.includes(failOn) : failOn.test(sql))
    ) {
      throw options.failWith ?? new Error(`boom: ${failOn}`);
    }
    return { rows: answer(remote, sql, options.countsAs ?? 'number') };
  };
  return { hostedQuery, queries };
}

const flatten = (sql: string) => sql.replace(/\s+/g, ' ').trim();

function aliasOf(flat: string, fallback: string): string {
  const aliases = [...flat.matchAll(/\bas\s+"?(\w+)"?/gi)];
  return aliases[aliases.length - 1]?.[1] ?? fallback;
}

function answer(
  remote: FakeRemote,
  sql: string,
  countsAs: NonNullable<FakeQueryOptions['countsAs']>
): Record<string, unknown>[] {
  const flat = flatten(sql);
  const text = flat.toLowerCase();
  if (!/^(select|with)\b/.test(text)) {
    throw new Error(`the fake database only answers reads: ${flat}`);
  }
  if (
    /pg_constraint|key_column_usage|constraint_column_usage|referential_constraints|table_constraints/.test(
      text
    )
  ) {
    return foreignKeyRows(remote, flat, text);
  }
  if (text.includes('to_regclass')) return regclassRows(remote, flat, text);
  if (text.includes('information_schema.columns')) {
    return columnRows(remote, text);
  }
  if (text.includes('information_schema.tables')) {
    return tableRows(remote, flat, text);
  }
  if (text.includes('schema_migrations')) {
    if (remote.history === null) {
      throw new Error(
        'relation "supabase_migrations.schema_migrations" does not exist'
      );
    }
    const versions = text.includes('order by version')
      ? [...remote.history].sort()
      : remote.history;
    return versions.map((version) => ({ version }));
  }
  if (/\bplans\b/.test(text)) return planRows(remote, flat, text);
  if (/\bprofiles\b/.test(text)) return profileRows(remote, flat, countsAs);
  throw new Error(`the fake database cannot answer: ${flat}`);
}

const qualified = (name: string) =>
  (name.includes('.') ? name : `public.${name}`).replaceAll('"', '');

function relationExists(remote: FakeRemote, name: string): boolean {
  switch (qualified(name).toLowerCase()) {
    case 'supabase_migrations.schema_migrations':
      return remote.history !== null;
    case 'public.plans':
      return remote.plans !== null;
    case 'public.profiles':
      return remote.profiles !== null;
    default:
      throw new Error(`the fake database has no relation ${name}`);
  }
}

function regclassRows(remote: FakeRemote, flat: string, text: string) {
  const target = /to_regclass\(\s*'([^']+)'\s*\)/i.exec(flat)?.[1] ?? '';
  const exists = relationExists(remote, target);
  const key = aliasOf(flat, 'to_regclass');
  if (/\bis (not )?null\b/.test(text)) {
    const present = /\bis null\b/.test(text) ? !exists : exists;
    return [{ [key]: text.includes('::int') ? Number(present) : present }];
  }
  return [{ [key]: exists ? qualified(target) : null }];
}

function tableRows(remote: FakeRemote, flat: string, text: string) {
  const table = /table_name\s*=\s*'(\w+)'/.exec(text)?.[1] ?? '';
  const exists = relationExists(remote, table);
  if (/\bcount\s*\(/.test(text)) {
    return [{ [aliasOf(flat, 'count')]: Number(exists) }];
  }
  return exists ? [{ table_name: table }] : [];
}

function columnRows(remote: FakeRemote, text: string) {
  const table = /table_name\s*=\s*'(\w+)'/.exec(text)?.[1];
  if (table !== 'plans' && table !== 'profiles') {
    throw new Error(
      `the fake database needs table_name = 'plans' or 'profiles': ${text}`
    );
  }
  const names =
    (table === 'plans' ? remote.plans : remote.profiles)?.columns ?? [];
  const only = /column_name\s*=\s*'(\w+)'/.exec(text)?.[1];
  return names
    .filter((name) => only === undefined || name === only)
    .map((column_name) => ({
      column_name,
      is_nullable:
        column_name === 'id' ||
        (column_name === 'plan_id' && !remote.planId.nullable)
          ? 'NO'
          : 'YES',
    }));
}

function foreignKeyRows(remote: FakeRemote, flat: string, text: string) {
  const { fkTarget } = remote.planId;
  const hasColumn = remote.profiles?.columns.includes('plan_id') ?? false;
  const found =
    hasColumn &&
    fkTarget !== null &&
    (!/\bplans\b/.test(text) || fkTarget === 'plans');
  if (/\bcount\s*\(/.test(text)) {
    return [{ [aliasOf(flat, 'count')]: Number(found) }];
  }
  if (/\bexists\b|\bbool_or\b|\bis not null\b/.test(text)) {
    return [{ [aliasOf(flat, 'exists')]: found }];
  }
  return found
    ? [
        {
          found: 1,
          table_name: fkTarget,
          foreign_table_name: fkTarget,
          referenced_table: fkTarget,
        },
      ]
    : [];
}

function planRows(remote: FakeRemote, flat: string, text: string) {
  if (remote.plans === null) {
    throw new Error('relation "public.plans" does not exist');
  }
  if (/\bcount\s*\(/.test(text)) {
    return [{ [aliasOf(flat, 'count')]: remote.plans.ids.length }];
  }
  const ids = /order by (id|1)\b/.test(text)
    ? [...remote.plans.ids].sort()
    : remote.plans.ids;
  return ids.map((id) => ({ id }));
}

function splitTopLevel(text: string, separator: ',' | 'from'): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "'") quoted = !quoted;
    else if (quoted) continue;
    else if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (depth === 0 && separator === ',' && char === ',') {
      parts.push(text.slice(start, i));
      start = i + 1;
    } else if (
      depth === 0 &&
      separator === 'from' &&
      /^from\b/i.test(text.slice(i)) &&
      /\s/.test(text[i - 1] ?? '')
    ) {
      parts.push(text.slice(start, i), text.slice(i + 4));
      return parts;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

type Predicate = (row: FakeProfile) => boolean;

function usernamePredicate(predicate: string): Predicate {
  const regex = /\busername\s*~(\*?)\s*'((?:[^']|'')*)'/i.exec(predicate);
  if (regex !== null) {
    const pattern = new RegExp(regex[2], regex[1] === '*' ? 'i' : '');
    return (row) => pattern.test(row.username);
  }
  if (/generate_series\(\s*1\s*,\s*(\d+)\s*\)/i.test(predicate)) {
    const upper = Number(
      /generate_series\(\s*1\s*,\s*(\d+)\s*\)/i.exec(predicate)?.[1]
    );
    const names = new Set(
      Array.from({ length: upper }, (_, index) => `user_${index + 1}`)
    );
    return (row) => names.has(row.username);
  }
  if (/\bin\s*\(|=\s*any\s*\(/i.test(predicate)) {
    const names = new Set(
      [...predicate.matchAll(/'((?:[^']|'')*)'/g)].map((match) => match[1])
    );
    return (row) => names.has(row.username);
  }
  throw new Error(`the fake database cannot evaluate: ${predicate}`);
}

function predicateOf(predicate: string): Predicate {
  const text = predicate.toLowerCase();
  const expected = (row: FakeProfile) => rightPlan(row);
  if (/\bis not distinct from\b/.test(text)) {
    return (row) => row.planId === expected(row);
  }
  if (/\bis distinct from\b/.test(text)) {
    return (row) => row.planId !== expected(row);
  }
  if (/\bplan_id\s*(<>|!=)/.test(text)) {
    return (row) => row.planId !== null && row.planId !== expected(row);
  }
  const equals = /\bplan_id\s*=\s*'(\w+)'/.exec(text);
  if (equals !== null) return (row) => row.planId === equals[1];
  if (/\bplan_id\s+is\s+not\s+null\b/.test(text)) {
    return (row) => row.planId !== null;
  }
  if (/\bplan_id\s+is\s+null\b/.test(text)) return (row) => row.planId === null;
  if (
    /\bnot\s+is_paid\b|\bis_paid\s*=\s*false\b|\bis_paid\s+is\s+(not\s+true|false)\b/.test(
      text
    )
  ) {
    return (row) => !row.isPaid;
  }
  if (/\bis_paid\b/.test(text)) return (row) => row.isPaid;
  if (/\busername\b/.test(text)) return usernamePredicate(predicate);
  throw new Error(`the fake database cannot evaluate: ${predicate}`);
}

function countItem(item: string): { filter: string | undefined } | undefined {
  let expr = item.trim().replace(/::\w+$/, '');
  if (expr.startsWith('(') && expr.endsWith(')')) expr = expr.slice(1, -1);
  const match =
    /^count\s*\(\s*\*\s*\)(?:\s*filter\s*\(\s*where\s+([\s\S]+)\))?$/i.exec(
      expr.trim()
    );
  return match === null ? undefined : { filter: match[1] };
}

const PROFILE_COLUMN_VALUES: Record<
  string,
  (row: FakeProfile, index: number) => unknown
> = {
  id: (_, index) =>
    `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
  username: (row) => row.username,
  is_paid: (row) => row.isPaid,
  plan_id: (row) => row.planId,
  created_at: () => '2026-09-01T00:00:00.000Z',
};

function profileRows(
  remote: FakeRemote,
  flat: string,
  countsAs: NonNullable<FakeQueryOptions['countsAs']>
): Record<string, unknown>[] {
  if (remote.profiles === null) {
    throw new Error('relation "public.profiles" does not exist');
  }
  const { columns, rows } = remote.profiles;
  for (const column of ['is_paid', 'plan_id']) {
    if (
      new RegExp(`\\b${column}\\b`, 'i').test(flat) &&
      !columns.includes(column)
    ) {
      throw new Error(`column "${column}" does not exist`);
    }
  }
  const [head, tail = ''] = splitTopLevel(flat, 'from');
  const list = head.replace(/^select\s+/i, '');
  const outerWhere = /\bwhere\s+([\s\S]+?)\s*;?$/i.exec(tail)?.[1];
  const base =
    outerWhere === undefined ? rows : rows.filter(predicateOf(outerWhere));

  const items = splitTopLevel(list, ',').map((item) => {
    const [, expr = item, alias] =
      /^([\s\S]*?)(?:\s+as\s+"?(\w+)"?)?$/i.exec(item.trim()) ?? [];
    return {
      expr: expr.trim(),
      alias,
      cast: /::(int|integer|smallint)\b/i.test(item),
    };
  });

  if (items.every(({ expr }) => countItem(expr) === undefined)) {
    const names = items.flatMap(({ expr }) =>
      expr === '*' ? columns : [expr.toLowerCase()]
    );
    for (const name of names) {
      if (!(name in PROFILE_COLUMN_VALUES) || !columns.includes(name)) {
        throw new Error(`column "${name}" does not exist`);
      }
    }
    return base.map((row, index) =>
      Object.fromEntries(
        names.map((name) => [name, PROFILE_COLUMN_VALUES[name](row, index)])
      )
    );
  }

  const row: Record<string, unknown> = {};
  for (const { expr, alias, cast } of items) {
    const count = countItem(expr);
    if (count === undefined) {
      throw new Error(`the fake database cannot evaluate: ${expr}`);
    }
    const n = (
      count.filter === undefined ? base : base.filter(predicateOf(count.filter))
    ).length;
    row[alias ?? 'count'] = cast
      ? n
      : countsAs === 'string'
        ? String(n)
        : countsAs === 'bigint'
          ? BigInt(n)
          : n;
  }
  return [row];
}
