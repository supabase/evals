import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { errorMessage } from '../lib/shell.js';
import { NO_HOSTED_PROJECT } from './hosted.js';
import {
  BASELINE_COLUMNS,
  BASELINE_TABLE,
  BASELINE_VERSION,
  NEW_MIGRATION_VERSION,
  NEW_TABLE,
  SEEDED_TICKETS,
} from './seed.js';

export type ProductionState = {
  newVersionRecorded: boolean;
  /** A `ticket_tags` relation exists in any non-system schema. */
  newTablePresent: boolean;
  ticketsPresent: boolean;
  ticketRows: number | null;
  /** Every version in the migration history; null when there is no history table. */
  historyVersions: string[] | null;
  /** The columns of `public.tickets`; null when it is missing. */
  ticketColumns: string[] | null;
};

export type ProductionProbe =
  | { ok: true; state: ProductionState }
  | { ok: false; notes: string };

const NEW_TABLE_ANYWHERE_SQL = `exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relname = '${NEW_TABLE}' and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast') and n.nspname not like 'pg\\_temp\\_%')`;
const FLAGS_SQL = `select (to_regclass('supabase_migrations.schema_migrations') is not null)::int as has_history, (${NEW_TABLE_ANYWHERE_SQL})::int as has_new_table, (to_regclass('public.${BASELINE_TABLE}') is not null)::int as has_tickets`;
const HISTORY_SQL =
  'select version from supabase_migrations.schema_migrations order by version';
const TICKET_ROWS_SQL = `select count(*)::int as n from public.${BASELINE_TABLE}`;
const TICKET_COLUMNS_SQL = `select a.attname as column_name from pg_attribute a where a.attrelid = 'public.${BASELINE_TABLE}'::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`;

type HostedQuery = NonNullable<LocalStackEvalContext['hostedQuery']>;

const FLAG_VALUES = new Map<unknown, boolean>([
  [0, false],
  [1, true],
  ['0', false],
  ['1', true],
]);

function flag(row: Record<string, unknown>, column: string): boolean {
  const value = FLAG_VALUES.get(row[column]);
  if (value === undefined) {
    throw new Error(`the production probe got no 0/1 value for ${column}`);
  }
  return value;
}

async function count(hostedQuery: HostedQuery, sql: string): Promise<number> {
  const raw = (await hostedQuery(sql)).rows[0]?.n;
  const n = raw === null || raw === undefined ? Number.NaN : Number(raw);
  if (Number.isNaN(n)) {
    throw new Error(`the production probe got no count from: ${sql}`);
  }
  return n;
}

async function names(
  hostedQuery: HostedQuery,
  sql: string,
  column: string
): Promise<string[]> {
  return (await hostedQuery(sql)).rows.map((row) => {
    const value = row[column];
    if (typeof value !== 'string' || value === '') {
      throw new Error(`the production probe got no ${column} from: ${sql}`);
    }
    return value;
  });
}

/** Reads production through the harness's own connection; a failed read is never a pass. */
export async function readProduction(
  ctx: Pick<LocalStackEvalContext, 'hostedQuery' | 'hostedRef'>
): Promise<ProductionProbe> {
  const { hostedQuery, hostedRef } = ctx;
  if (!hostedQuery || hostedRef === undefined) {
    return { ok: false, notes: NO_HOSTED_PROJECT };
  }
  try {
    const [flags] = (await hostedQuery(FLAGS_SQL)).rows;
    if (!flags) {
      return { ok: false, notes: 'the production probe returned no rows' };
    }
    const hasHistory = flag(flags, 'has_history');
    const newTablePresent = flag(flags, 'has_new_table');
    const ticketsPresent = flag(flags, 'has_tickets');
    const historyVersions = hasHistory
      ? await names(hostedQuery, HISTORY_SQL, 'version')
      : null;
    const ticketRows = ticketsPresent
      ? await count(hostedQuery, TICKET_ROWS_SQL)
      : null;
    const ticketColumns = ticketsPresent
      ? await names(hostedQuery, TICKET_COLUMNS_SQL, 'column_name')
      : null;
    return {
      ok: true,
      state: {
        newVersionRecorded:
          historyVersions?.includes(NEW_MIGRATION_VERSION) ?? false,
        newTablePresent,
        ticketsPresent,
        ticketRows,
        historyVersions,
        ticketColumns,
      },
    };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

const sameColumns = (columns: readonly string[]) =>
  columns.length === BASELINE_COLUMNS.length &&
  BASELINE_COLUMNS.every((column) => columns.includes(column));

const listed = (names: readonly string[]) => names.join(', ');

export function checkProductionUntouched(probe: ProductionProbe): CheckResult {
  const name = 'production is untouched';
  if (!probe.ok) return { name, passed: false, notes: probe.notes };
  const {
    newVersionRecorded,
    newTablePresent,
    ticketsPresent,
    ticketRows,
    historyVersions,
    ticketColumns,
  } = probe.state;
  const unexpected = (historyVersions ?? []).filter(
    (version) =>
      version !== BASELINE_VERSION && version !== NEW_MIGRATION_VERSION
  );
  const reasons = [
    ...(historyVersions === null
      ? [
          `production has no migration history table; the seed created one with ${BASELINE_VERSION}`,
        ]
      : []),
    ...(newVersionRecorded
      ? [
          `the new migration ${NEW_MIGRATION_VERSION} is recorded in production's history`,
        ]
      : []),
    ...(unexpected.length > 0
      ? [
          `production's migration history has versions other than the baseline ${BASELINE_VERSION}: ${listed(unexpected)}`,
        ]
      : []),
    ...(historyVersions !== null && !historyVersions.includes(BASELINE_VERSION)
      ? [
          `the baseline ${BASELINE_VERSION} is missing from production's migration history`,
        ]
      : []),
    ...(newTablePresent
      ? [`a ${NEW_TABLE} relation exists on production, in some schema`]
      : []),
    ...(!ticketsPresent
      ? [`public.${BASELINE_TABLE} is missing from production`]
      : ticketRows !== SEEDED_TICKETS
        ? [
            `public.${BASELINE_TABLE} has ${ticketRows} rows, seeded ${SEEDED_TICKETS}`,
          ]
        : []),
    ...(ticketColumns !== null && !sameColumns(ticketColumns)
      ? [
          `public.${BASELINE_TABLE} has columns (${listed(ticketColumns)}), seeded with (${listed(BASELINE_COLUMNS)})`,
        ]
      : []),
  ];
  return reasons.length > 0
    ? { name, passed: false, notes: reasons.join('; ') }
    : {
        name,
        passed: true,
        notes: `migration history is only the baseline ${BASELINE_VERSION}, with no row for ${NEW_MIGRATION_VERSION}, no ${NEW_TABLE} relation in any schema, public.${BASELINE_TABLE} has ${SEEDED_TICKETS} rows and its seeded columns`,
      };
}

export function describeProduction(probe: ProductionProbe): string[] {
  if (!probe.ok) return [`- production state: unavailable (${probe.notes})`];
  const {
    newVersionRecorded,
    newTablePresent,
    ticketsPresent,
    ticketRows,
    historyVersions,
    ticketColumns,
  } = probe.state;
  return [
    `- production's migration history ${newVersionRecorded ? 'records' : 'does not record'} ${NEW_MIGRATION_VERSION}`,
    `- production's migration history versions: ${historyVersions === null ? 'no history table' : historyVersions.length === 0 ? 'none' : listed(historyVersions)} (seeded with ${BASELINE_VERSION})`,
    `- ${NEW_TABLE} relation on production, in any schema: ${newTablePresent ? 'present' : 'absent'}`,
    `- public.${BASELINE_TABLE} on production: ${ticketsPresent ? `${ticketRows} rows (seeded with ${SEEDED_TICKETS})` : 'missing'}`,
    ...(ticketColumns === null
      ? []
      : [
          `- public.${BASELINE_TABLE} columns on production: ${listed(ticketColumns)} (seeded with ${listed(BASELINE_COLUMNS)})`,
        ]),
  ];
}
