import type {
  CommandResult,
  LocalStackEvalContext,
  ToolCallRecord,
} from '@supabase-evals/core';
import {
  columnsSql,
  HISTORY_SQL,
  HISTORY_TABLE,
  PLAN_ID_FOREIGN_KEY,
  PLAN_ID_NULLABILITY_SQL,
  PLAN_IDS_SQL,
  profileCountsSql,
  relationPresentSql,
} from './remote.js';

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

export const readPoolerUrlRoute = (respond: Respond): Route => [
  'cat supabase/.temp/pooler-url',
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

type Rows = Record<string, unknown>[];

const missingRelation = (name: string) =>
  new Error(`relation "${name}" does not exist`);

const SEEDED_USERNAMES = new Set(SEEDED_USERS.map(({ username }) => username));

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
  const { history, plans, profiles, planId } = remote;
  const int = (n: number) =>
    countsAs === 'string' ? String(n) : countsAs === 'bigint' ? BigInt(n) : n;
  const answers = new Map<string, (sql: string) => Rows>();

  for (const [name, state] of [
    [HISTORY_TABLE, history],
    ['public.plans', plans],
    ['public.profiles', profiles],
  ] as const) {
    answers.set(relationPresentSql(name), () => [
      { present: int(state === null ? 0 : 1) },
    ]);
  }

  for (const [table, state] of [
    ['plans', plans],
    ['profiles', profiles],
  ] as const) {
    answers.set(columnsSql(table), () =>
      (state?.columns ?? []).map((column_name) => ({ column_name }))
    );
  }

  answers.set(HISTORY_SQL, (sql) => {
    if (history === null) throw missingRelation(HISTORY_TABLE);
    const versions = /\border by version\b/.test(sql)
      ? [...history].sort()
      : history;
    return versions.map((version) => ({ version }));
  });

  answers.set(PLAN_IDS_SQL, (sql) => {
    if (plans === null) throw missingRelation('public.plans');
    const ids = /\border by id\b/.test(sql) ? [...plans.ids].sort() : plans.ids;
    return ids.map((id) => ({ id }));
  });

  const hasPlanId = profiles?.columns.includes('plan_id') ?? false;
  answers.set(PLAN_ID_NULLABILITY_SQL, () =>
    hasPlanId ? [{ is_nullable: planId.nullable ? 'YES' : 'NO' }] : []
  );
  answers.set(PLAN_ID_FOREIGN_KEY, () => [
    { found: int(hasPlanId && planId.fkTarget === 'plans' ? 1 : 0) },
  ]);

  for (const hasPaid of [false, true]) {
    for (const hasPlan of [false, true]) {
      answers.set(profileCountsSql(hasPaid, hasPlan), () => {
        if (profiles === null) throw missingRelation('public.profiles');
        for (const [used, column] of [
          [hasPaid, 'is_paid'],
          [hasPlan, 'plan_id'],
        ] as const) {
          if (used && !profiles.columns.includes(column)) {
            throw new Error(`column "${column}" does not exist`);
          }
        }
        const count = (match: (row: FakeProfile) => boolean) =>
          int(profiles.rows.filter(match).length);
        return [
          {
            total: int(profiles.rows.length),
            seeded: count(({ username }) => SEEDED_USERNAMES.has(username)),
            ...(hasPaid ? { paid: count((row) => row.isPaid) } : {}),
            ...(hasPlan
              ? {
                  on_pro: count((row) => row.planId === 'pro'),
                  on_free: count((row) => row.planId === 'free'),
                }
              : {}),
            ...(hasPaid && hasPlan
              ? { misassigned: count((row) => row.planId !== rightPlan(row)) }
              : {}),
          },
        ];
      });
    }
  }

  return answers;
}
