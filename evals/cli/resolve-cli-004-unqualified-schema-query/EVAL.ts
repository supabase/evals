import type { CheckResult, LocalStackScorer } from '@supabase-evals/core';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import { extractCommandEntries } from '../lib/detours.js';
import {
  checkStackRunning,
  runSql,
  scoreWithDocUrlMetrics,
  scorerFailure,
} from '../lib/docurl.js';
import { resolveStackWithAgentHomes, type StackProbe } from '../lib/stack.js';
import { errorMessage } from '../lib/shell.js';
import {
  ARTICLE_URL,
  EXPECTED_INVOICES,
  EXPECTED_REPORT,
  INVOICES_SQL,
  REPORT_SCRIPT,
} from './fixtures.js';

type Ctx = Parameters<LocalStackScorer>[0];

/**
 * Scores "make the revenue report run and keep the data where it is". The
 * checks read the live database and the report script in the workspace.
 * `read_doc_url` and `saw_doc_url` ride along as metrics and never change
 * `passed`.
 */
const scorer: LocalStackScorer = async (ctx) => {
  try {
    const marker = await ctx.environmentMarker();
    const invocations = findSupabaseInvocations(
      extractCommandEntries(ctx.toolCalls),
      { sandboxEnv: marker?.env }
    );
    const stack = await resolveStackWithAgentHomes(
      ctx,
      { kind: 'root' },
      invocations
    );
    const script = await readScript(ctx);
    const gating: CheckResult[] = [
      await checkStackRunning(ctx, stack),
      await checkInvoicesIntact(ctx, stack),
      checkScriptStillReports(script),
      await checkReportRuns(ctx, stack, script),
    ];
    return scoreWithDocUrlMetrics(gating, ctx.toolCalls, ARTICLE_URL);
  } catch (error) {
    return scorerFailure('resolve-cli-004-unqualified-schema-query', error);
  }
};

export default scorer;

export const INVOICES_CHECK =
  'billing.invoices still holds the seeded invoices';
export const SCRIPT_CHECK =
  'the report script still sums invoices per customer';
export const REPORT_CHECK =
  'the report script runs and returns the revenue per customer';

export type ScriptRead =
  | { ok: true; sql: string }
  | { ok: false; notes: string };

async function readScript(ctx: Pick<Ctx, 'readFile'>): Promise<ScriptRead> {
  try {
    return { ok: true, sql: await ctx.readFile(REPORT_SCRIPT) };
  } catch (error) {
    return {
      ok: false,
      notes: `cannot read ${REPORT_SCRIPT}: ${errorMessage(error)}`,
    };
  }
}

/** The tables must stay in their schema with all rows. */
export async function checkInvoicesIntact(
  ctx: Pick<Ctx, 'exec'>,
  stack: StackProbe
): Promise<CheckResult> {
  const run = await runSql(ctx, stack, INVOICES_SQL, { fieldSeparator: '|' });
  if (!run.ok) return { name: INVOICES_CHECK, passed: false, notes: run.notes };
  const actual = run.stdout.trim();
  return {
    name: INVOICES_CHECK,
    passed: actual === EXPECTED_INVOICES,
    notes: `count|sum is ${actual}, expected ${EXPECTED_INVOICES}`,
  };
}

/** Guards against a script that prints the numbers without reading the table. */
export function checkScriptStillReports(script: ScriptRead): CheckResult {
  if (!script.ok)
    return { name: SCRIPT_CHECK, passed: false, notes: script.notes };
  const passed =
    /\binvoices\b/i.test(script.sql) &&
    /\bsum\s*\(\s*amount_cents\s*\)/i.test(script.sql);
  return {
    name: SCRIPT_CHECK,
    passed,
    notes: passed
      ? undefined
      : 'the script no longer selects sum(amount_cents) from invoices',
  };
}

/** Runs the workspace script in a fresh psql session, so a session-only setting cannot hide the failure. */
export async function checkReportRuns(
  ctx: Pick<Ctx, 'exec'>,
  stack: StackProbe,
  script: ScriptRead
): Promise<CheckResult> {
  if (!script.ok)
    return { name: REPORT_CHECK, passed: false, notes: script.notes };
  const run = await runSql(ctx, stack, script.sql, { fieldSeparator: '|' });
  if (!run.ok) return { name: REPORT_CHECK, passed: false, notes: run.notes };
  const lines = run.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const passed =
    lines.length === EXPECTED_REPORT.length &&
    EXPECTED_REPORT.every((row, index) => lines[index] === row);
  return {
    name: REPORT_CHECK,
    passed,
    notes: passed
      ? 'the report matches the seeded invoices'
      : `report output was: ${lines.join(' / ') || '(empty)'}`,
  };
}
