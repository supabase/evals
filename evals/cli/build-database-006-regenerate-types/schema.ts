import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { describeFailure, errorMessage, shellQuote } from '../lib/shell.js';
import type { StackProbe } from '../lib/stack.js';
import type { StackLifecycle } from './metrics.js';

export const NEW_MIGRATION_VERSION = '20260315000000';

export type SchemaProbe =
  | {
      ok: true;
      applied: boolean;
      columns: Record<string, string>;
      appliedError?: string;
    }
  | { ok: false; notes: string };

const COLUMNS_SQL =
  "select column_name, udt_name from information_schema.columns where table_schema = 'public' and table_name = 'tasks'";

const MISSING_HISTORY =
  /relation "supabase_migrations\.schema_migrations" does not exist/;
const APPLIED_SQL = `select count(*) from supabase_migrations.schema_migrations where version = '${NEW_MIGRATION_VERSION}'`;

/** `public.tasks` column names mapped to their Postgres type names, plus whether the new migration is in the applied history. */
export async function readTasksSchema(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  stack: StackProbe
): Promise<SchemaProbe> {
  if (!stack.ok) return { ok: false, notes: stack.notes };
  const psql = (sql: string) =>
    `psql ${shellQuote(stack.dbUrl)} -tAc ${shellQuote(sql)}`;
  try {
    const columnsResult = await ctx.exec(psql(COLUMNS_SQL));
    if (!columnsResult.ok) {
      return {
        ok: false,
        notes: `columns query failed: ${describeFailure(columnsResult)}`,
      };
    }
    const columns: Record<string, string> = {};
    for (const line of columnsResult.stdout.split('\n')) {
      const [name, type] = line.trim().split('|');
      if (name && type) columns[name] = type;
    }
    const appliedResult = await ctx.exec(psql(APPLIED_SQL));
    const applied =
      appliedResult.ok && Number.parseInt(appliedResult.stdout.trim(), 10) > 0;
    // A missing history table fails this query, which means nothing was applied.
    const unexpectedFailure =
      !appliedResult.ok &&
      !MISSING_HISTORY.test(`${appliedResult.stderr}${appliedResult.stdout}`);
    return {
      ok: true,
      applied,
      columns,
      ...(unexpectedFailure
        ? { appliedError: describeFailure(appliedResult) }
        : {}),
    };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

export function checkMigrationApplied(
  probe: SchemaProbe,
  lifecycle?: StackLifecycle
): CheckResult {
  const name = 'new migration is applied to the local database';
  if (!probe.ok) {
    return {
      name,
      passed: false,
      notes: lifecycle?.stoppedByAgent
        ? `the agent stopped the stack (last stack command: \`${lifecycle.lastCommand}\`), so the harness could not probe the database; ${probe.notes}`
        : probe.notes,
    };
  }
  const problems: string[] = [];
  if (!probe.applied) {
    problems.push(
      `${NEW_MIGRATION_VERSION} not in applied history${probe.appliedError === undefined ? '' : ` (history query failed: ${probe.appliedError})`}`
    );
  }
  if (probe.columns.status !== 'task_status') {
    problems.push(
      `status is ${probe.columns.status ?? 'missing'}, expected task_status`
    );
  }
  if (!('due_on' in probe.columns)) problems.push('due_on missing');
  if ('is_complete' in probe.columns)
    problems.push('is_complete still present');
  return {
    name,
    passed: problems.length === 0,
    notes:
      problems.length === 0
        ? `${NEW_MIGRATION_VERSION} applied; public.tasks has status and due_on and no is_complete`
        : problems.join('; '),
  };
}
