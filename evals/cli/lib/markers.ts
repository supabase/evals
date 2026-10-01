import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import {
  describeFailure,
  errorMessage,
  shellQuote,
  truncate,
} from './shell.js';
import type { ResolvedStack } from './stack.js';

export type RowStringsProbe =
  | { ok: true; values: string[] }
  | { ok: false; notes: string };

/**
 * Every string value in every row of `qualifiedTable`, read via `to_jsonb` so
 * the agent's choice of marker column name doesn't matter. A missing table
 * surfaces through psql's own "relation does not exist" error.
 */
export async function readRowStrings(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  stack: ResolvedStack,
  qualifiedTable: string
): Promise<RowStringsProbe> {
  try {
    const result = await ctx.exec(
      `psql ${shellQuote(
        stack.dbUrl
      )} -tAc "select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from ${qualifiedTable} t"`
    );
    if (!result.ok) return { ok: false, notes: describeFailure(result) };
    let rows: Array<Record<string, unknown>>;
    try {
      rows = JSON.parse(result.stdout.trim());
    } catch {
      return {
        ok: false,
        notes: `could not parse ${qualifiedTable} rows: ${truncate(result.stdout, 200)}`,
      };
    }
    const values = rows.flatMap((row) =>
      Object.values(row).filter(
        (value): value is string => typeof value === 'string'
      )
    );
    return { ok: true, values };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

/**
 * Passes when every database holds a row naming its own label and none naming
 * another entry's label (case-insensitive) — proving each write reached the
 * right stack rather than all landing in one database.
 */
export function checkMarkerIsolation(
  name: string,
  entries: ReadonlyArray<{ label: string; rows: RowStringsProbe }>
): CheckResult {
  const describe = ({ label, rows }: (typeof entries)[number]) =>
    `${label} db rows: ${rows.ok ? JSON.stringify(rows.values) : rows.notes}`;
  const notes = entries.map(describe).join('; ');
  if (entries.some(({ rows }) => !rows.ok)) {
    return { name, passed: false, notes };
  }

  const holds = (values: readonly string[], label: string) =>
    values.some((value) => value.toLowerCase().includes(label.toLowerCase()));
  const passed = entries.every(
    ({ label, rows }) =>
      rows.ok &&
      holds(rows.values, label) &&
      entries.every(
        (other) => other.label === label || !holds(rows.values, other.label)
      )
  );
  return { name, passed, notes };
}
