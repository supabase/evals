import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { errorMessage } from '../lib/shell.js';
import {
  PLAN_IDS,
  PLANS_COLUMNS,
  PLANS_MIGRATION_VERSION,
  SEEDED_PAID_PROFILES,
  SEEDED_PROFILES,
} from './seed.js';

type HostedContext = Pick<LocalStackEvalContext, 'hostedQuery' | 'hostedRef'>;
type Query = (sql: string) => Promise<Record<string, unknown>[]>;

export const NO_HOSTED_PROJECT =
  'the run has no hosted project (CLI-2754 tracks adding one to CI)';

export type Probe<T> = { ok: true; value: T } | { ok: false; notes: string };

export const HOSTED_CHECK_NAME = 'a hosted project is available to push to';
export const HISTORY_CHECK_NAME =
  "the plans migration is in the hosted project's migration history";
export const SCHEMA_CHECK_NAME = 'the hosted schema has the plans change';
export const DATA_CHECK_NAME = 'the hosted data looks right after the push';

const HISTORY_TABLE = 'supabase_migrations.schema_migrations';

const PLAN_ID_FOREIGN_KEY = `
  select count(*)::int as found
  from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
  where c.contype = 'f'
    and c.conrelid = to_regclass('public.profiles')
    and c.confrelid = to_regclass('public.plans')
    and a.attname = 'plan_id'
`;

export function hasHostedProject(ctx: HostedContext): boolean {
  return Boolean(ctx.hostedQuery && ctx.hostedRef);
}

async function probe<T>(
  ctx: HostedContext,
  read: (query: Query) => Promise<T>
): Promise<Probe<T>> {
  const { hostedQuery } = ctx;
  if (!hostedQuery || !hasHostedProject(ctx)) {
    return { ok: false, notes: NO_HOSTED_PROJECT };
  }
  try {
    const query: Query = async (sql) => (await hostedQuery(sql)).rows;
    return { ok: true, value: await read(query) };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

async function relationExists(
  query: Query,
  relation: string
): Promise<boolean> {
  const [row] = await query(
    `select (to_regclass('${relation}') is not null)::int as present`
  );
  return Number(row?.present) === 1;
}

async function columnsOf(query: Query, table: string): Promise<string[]> {
  const rows = await query(
    `select column_name::text as column_name from information_schema.columns where table_schema = 'public' and table_name = '${table}' order by ordinal_position`
  );
  return rows.map((row) => String(row.column_name));
}

export function readHistory(ctx: HostedContext): Promise<Probe<string[]>> {
  return probe(ctx, async (query) => {
    if (!(await relationExists(query, HISTORY_TABLE))) return [];
    const rows = await query(
      `select version::text as version from ${HISTORY_TABLE} order by version`
    );
    return rows.map((row) => String(row.version));
  });
}

export type RemoteSchema = {
  plansColumns: string[];
  planId: { nullable: boolean; referencesPlans: boolean } | null;
};

export function readSchema(ctx: HostedContext): Promise<Probe<RemoteSchema>> {
  return probe(ctx, async (query) => {
    const plansColumns = await columnsOf(query, 'plans');
    const [column] = await query(
      "select is_nullable::text as is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'plan_id'"
    );
    if (column === undefined) return { plansColumns, planId: null };
    const [foreignKey] = await query(PLAN_ID_FOREIGN_KEY);
    return {
      plansColumns,
      planId: {
        nullable: column.is_nullable !== 'NO',
        referencesPlans: Number(foreignKey?.found) > 0,
      },
    };
  });
}

export type RemoteData = {
  plansTable: boolean;
  planIds: string[];
  profiles: number;
  seededProfiles: number;
  paid: number | null;
  onPro: number | null;
  onFree: number | null;
  misassigned: number | null;
};

export function readData(ctx: HostedContext): Promise<Probe<RemoteData>> {
  return probe(ctx, async (query) => {
    const plansTable = await relationExists(query, 'public.plans');
    const planIds =
      plansTable && (await columnsOf(query, 'plans')).includes('id')
        ? (
            await query('select id::text as id from public.plans order by id')
          ).map((row) => String(row.id))
        : [];

    if (!(await relationExists(query, 'public.profiles'))) {
      return {
        plansTable,
        planIds,
        profiles: 0,
        seededProfiles: 0,
        paid: null,
        onPro: null,
        onFree: null,
        misassigned: null,
      };
    }

    const columns = await columnsOf(query, 'profiles');
    const hasPaid = columns.includes('is_paid');
    const hasPlan = columns.includes('plan_id');
    const counts = [
      'count(*)::int as total',
      `count(*) filter (where username in (select 'user_' || n from generate_series(1, ${SEEDED_PROFILES}) as n))::int as seeded`,
      ...(hasPaid ? ['count(*) filter (where is_paid)::int as paid'] : []),
      ...(hasPlan
        ? [
            "count(*) filter (where plan_id = 'pro')::int as on_pro",
            "count(*) filter (where plan_id = 'free')::int as on_free",
          ]
        : []),
      ...(hasPaid && hasPlan
        ? [
            "count(*) filter (where plan_id is distinct from (case when is_paid then 'pro' else 'free' end))::int as misassigned",
          ]
        : []),
    ];
    const [row] = await query(
      `select ${counts.join(', ')} from public.profiles`
    );
    return {
      plansTable,
      planIds,
      profiles: Number(row?.total),
      seededProfiles: Number(row?.seeded),
      paid: hasPaid ? Number(row?.paid) : null,
      onPro: hasPlan ? Number(row?.on_pro) : null,
      onFree: hasPlan ? Number(row?.on_free) : null,
      misassigned: hasPaid && hasPlan ? Number(row?.misassigned) : null,
    };
  });
}

export function checkHostedProject(ctx: HostedContext): CheckResult {
  const name = HOSTED_CHECK_NAME;
  return hasHostedProject(ctx)
    ? { name, passed: true, notes: `hosted project ${ctx.hostedRef}` }
    : { name, passed: false, notes: NO_HOSTED_PROJECT };
}

export function checkMigrationRecorded(history: Probe<string[]>): CheckResult {
  const name = HISTORY_CHECK_NAME;
  if (!history.ok) return { name, passed: false, notes: history.notes };
  if (history.value.includes(PLANS_MIGRATION_VERSION)) {
    return { name, passed: true };
  }
  return {
    name,
    passed: false,
    notes: `version ${PLANS_MIGRATION_VERSION} is not recorded (found: ${history.value.join(', ') || 'none'})`,
  };
}

export function checkRemoteSchema(schema: Probe<RemoteSchema>): CheckResult {
  const name = SCHEMA_CHECK_NAME;
  if (!schema.ok) return { name, passed: false, notes: schema.notes };
  const { plansColumns, planId } = schema.value;
  const problems: string[] = [];
  if (plansColumns.length === 0) {
    problems.push('public.plans is missing');
  } else {
    for (const column of PLANS_COLUMNS) {
      if (!plansColumns.includes(column)) {
        problems.push(`public.plans has no ${column} column`);
      }
    }
  }
  if (planId === null) {
    problems.push('public.profiles.plan_id is missing');
  } else {
    if (planId.nullable) {
      problems.push('public.profiles.plan_id is nullable, expected not null');
    }
    if (!planId.referencesPlans) {
      problems.push('public.profiles.plan_id has no foreign key to plans');
    }
  }
  return problems.length === 0
    ? { name, passed: true }
    : { name, passed: false, notes: problems.join('; ') };
}

export function checkRemoteData(data: Probe<RemoteData>): CheckResult {
  const name = DATA_CHECK_NAME;
  if (!data.ok) return { name, passed: false, notes: data.notes };
  const {
    plansTable,
    planIds,
    profiles,
    seededProfiles,
    paid,
    onPro,
    onFree,
    misassigned,
  } = data.value;
  const known = (count: number | null) => count ?? 'unknown';

  const problems: string[] = [];
  if (!plansTable) problems.push('public.plans is missing');
  if (planIds.join(',') !== PLAN_IDS.join(',')) {
    problems.push(`plan ids are [${planIds.join(', ')}]`);
  }
  if (profiles !== SEEDED_PROFILES) {
    problems.push(`${profiles} profiles, expected ${SEEDED_PROFILES}`);
  }
  if (seededProfiles !== SEEDED_PROFILES) {
    problems.push(`${seededProfiles} of the seeded users remain`);
  }
  if (paid !== SEEDED_PAID_PROFILES) {
    problems.push(
      paid === null
        ? 'the paid user count is unknown'
        : `${paid} paid users, expected ${SEEDED_PAID_PROFILES}`
    );
  }
  if (misassigned !== 0) {
    problems.push(
      misassigned === null
        ? 'the number of users on the wrong plan is unknown'
        : `${misassigned} users on the wrong plan`
    );
  }

  const counts = `${profiles} profiles, ${known(paid)} paid, ${known(onPro)} on pro, ${known(onFree)} on free`;
  return problems.length === 0
    ? { name, passed: true, notes: counts }
    : { name, passed: false, notes: `${problems.join('; ')} (${counts})` };
}
