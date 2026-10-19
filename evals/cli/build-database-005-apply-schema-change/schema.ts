import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { describeFailure, errorMessage, shellQuote } from '../lib/shell.js';
import { probeStackReady, type StackProbe } from '../lib/stack.js';
import { DUE_DATE_COLUMN, DUE_DATE_TYPES, TASKS_TABLE } from './fixtures.js';

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;

export type ColumnProbe =
  | { ok: true; exists: false }
  | { ok: true; exists: true; dataType: string; nullable: boolean }
  | { ok: false; notes: string };

export const STACK_CHECK_NAME = 'local stack is running for this project';
export const COLUMN_CHECK_NAME =
  'tasks.due_date exists in the local database as a nullable date or timestamp';

const COLUMN_ROW_RE = /^([^|]+)\|(YES|NO)$/;

export async function checkStackRunning(
  ctx: ExecContext,
  stack: StackProbe
): Promise<CheckResult> {
  const { ready, notes } = await probeStackReady(ctx, stack);
  return { name: STACK_CHECK_NAME, passed: ready, notes };
}

export async function readDueDateColumn(
  ctx: ExecContext,
  stack: StackProbe
): Promise<ColumnProbe> {
  if (!stack.ok) return { ok: false, notes: stack.notes };
  try {
    const result = await ctx.exec(
      `psql ${shellQuote(stack.dbUrl)} -tAc "select data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = '${TASKS_TABLE}' and column_name = '${DUE_DATE_COLUMN}'"`
    );
    if (!result.ok) return { ok: false, notes: describeFailure(result) };
    const output = result.stdout.trim();
    if (output === '') return { ok: true, exists: false };
    const row = COLUMN_ROW_RE.exec(output);
    if (!row) {
      return {
        ok: false,
        notes: `unrecognised column probe output: ${output}`,
      };
    }
    return {
      ok: true,
      exists: true,
      dataType: row[1],
      nullable: row[2] === 'YES',
    };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

export function checkDueDateColumn(column: ColumnProbe): CheckResult {
  const name = COLUMN_CHECK_NAME;
  if (!column.ok) {
    return {
      name,
      passed: false,
      notes: `could not read tasks.due_date: ${column.notes}`,
    };
  }
  if (!column.exists) {
    return {
      name,
      passed: false,
      notes: 'tasks.due_date is missing from the local database',
    };
  }
  if (!DUE_DATE_TYPES.includes(column.dataType)) {
    return {
      name,
      passed: false,
      notes: `tasks.due_date has the wrong type ${column.dataType}; expected ${DUE_DATE_TYPES.join(', ')}`,
    };
  }
  if (!column.nullable) {
    return {
      name,
      passed: false,
      notes: `tasks.due_date is ${column.dataType} NOT NULL; the app clears due dates by writing null`,
    };
  }
  return { name, passed: true, notes: `${column.dataType}, nullable` };
}

/** Row count of `public.tasks`, or null when the stack is down or the probe fails. */
export async function countTaskRows(
  ctx: ExecContext,
  stack: StackProbe
): Promise<number | null> {
  if (!stack.ok) return null;
  try {
    const result = await ctx.exec(
      `psql ${shellQuote(stack.dbUrl)} -tAc "select count(*) from public.${TASKS_TABLE}"`
    );
    const output = result.stdout.trim();
    return result.ok && /^\d+$/.test(output) ? Number(output) : null;
  } catch {
    return null;
  }
}
