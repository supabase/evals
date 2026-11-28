import type { CheckResult, LocalStackScorer } from '@supabase-evals/core';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import { extractCommandEntries } from '../lib/detours.js';
import {
  checkStackRunning,
  runSql,
  scoreWithDocUrlMetrics,
  scorerFailure,
} from '../lib/docurl.js';
import { errorMessage } from '../lib/shell.js';
import { resolveStackWithAgentHomes, type StackProbe } from '../lib/stack.js';
import {
  ARTICLE_URL,
  POOLER_URL,
  REPORT_SCRIPT,
  ROUNDS,
  SEEDED_ORDERS,
  SEEDED_ORDERS_SQL,
  SIGNUP_INSERT_SQL,
} from './fixtures.js';

type Ctx = Parameters<LocalStackScorer>[0];

/**
 * Scores "make the report-then-signup order work through the pooler, and keep
 * the report read-only". The checks go through the pooler in fresh psql
 * sessions. `read_doc_url` and `saw_doc_url` ride along as metrics and never
 * change `passed`.
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
    const gating: CheckResult[] = [
      await checkStackRunning(ctx, stack),
      await checkOrdersIntact(ctx, stack),
      await checkReportStaysReadOnly(ctx),
      await checkReportThenSignup(ctx, stack),
    ];
    return scoreWithDocUrlMetrics(gating, ctx.toolCalls, ARTICLE_URL);
  } catch (error) {
    return scorerFailure('resolve-cli-007-pooler-read-only-state', error);
  }
};

export default scorer;

export const ORDERS_CHECK = 'the seeded orders are still there';
export const READ_ONLY_CHECK = 'the report script still asks for read-only';
export const SIGNUP_CHECK =
  'the signup insert works through the pooler after each report run';

/** Passes when every seeded order is still in the table. */
export async function checkOrdersIntact(
  ctx: Pick<Ctx, 'exec'>,
  stack: StackProbe
): Promise<CheckResult> {
  const run = await runSql(ctx, stack, SEEDED_ORDERS_SQL);
  if (!run.ok) return { name: ORDERS_CHECK, passed: false, notes: run.notes };
  const lines = run.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const missing = SEEDED_ORDERS.filter((item) => !lines.includes(item));
  return {
    name: ORDERS_CHECK,
    passed: missing.length === 0,
    notes:
      missing.length === 0
        ? `${SEEDED_ORDERS.length} seeded orders present`
        : `missing: ${missing.join(', ')}`,
  };
}

/**
 * A guard against the fix that deletes the safety setting. The script must
 * still mention read-only mode and still read the orders.
 */
export async function checkReportStaysReadOnly(
  ctx: Pick<Ctx, 'readFile'>
): Promise<CheckResult> {
  try {
    const script = await ctx.readFile(REPORT_SCRIPT);
    const passed =
      /read[\s_]only/i.test(script) && /from\s+public\.orders/i.test(script);
    return {
      name: READ_ONLY_CHECK,
      passed,
      notes: passed
        ? undefined
        : 'the report script no longer sets read-only mode or no longer reads the orders',
    };
  } catch (error) {
    return {
      name: READ_ONLY_CHECK,
      passed: false,
      notes: `cannot read ${REPORT_SCRIPT}: ${errorMessage(error)}`,
    };
  }
}

/**
 * First the signup insert alone, which finds a backend that an earlier run left
 * read-only. Then the workspace report script and the signup insert, in that
 * order, several times. Each statement is a fresh psql session through the
 * pooler. A pool backend that keeps read-only state fails the insert.
 */
export async function checkReportThenSignup(
  ctx: Pick<Ctx, 'exec' | 'readFile'>,
  stack: StackProbe
): Promise<CheckResult> {
  let report: string;
  try {
    report = await ctx.readFile(REPORT_SCRIPT);
  } catch (error) {
    return {
      name: SIGNUP_CHECK,
      passed: false,
      notes: `cannot read ${REPORT_SCRIPT}: ${errorMessage(error)}`,
    };
  }
  const options = { dbUrl: POOLER_URL };
  const clean = await runSql(ctx, stack, SIGNUP_INSERT_SQL, options);
  if (!clean.ok) {
    return {
      name: SIGNUP_CHECK,
      passed: false,
      notes: `before any report run: ${clean.notes}`,
    };
  }
  for (let round = 1; round <= ROUNDS; round += 1) {
    const reported = await runSql(ctx, stack, report, options);
    if (!reported.ok) {
      return {
        name: SIGNUP_CHECK,
        passed: false,
        notes: `report run ${round} failed: ${reported.notes}`,
      };
    }
    const signup = await runSql(ctx, stack, SIGNUP_INSERT_SQL, options);
    if (!signup.ok) {
      return {
        name: SIGNUP_CHECK,
        passed: false,
        notes: `signup after report run ${round} failed: ${signup.notes}`,
      };
    }
  }
  return {
    name: SIGNUP_CHECK,
    passed: true,
    notes: `${ROUNDS} report-then-signup rounds succeeded`,
  };
}
