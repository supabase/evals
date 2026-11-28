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
import {
  ARTICLE_URL,
  SEEDED_CUSTOMERS,
  SEEDED_CUSTOMERS_SQL,
  SIGNUP_INSERT_SQL,
} from './fixtures.js';

type Ctx = Parameters<LocalStackScorer>[0];

/**
 * Scores "make the signup insert work without losing customers". The checks
 * read the live database. `read_doc_url` and `saw_doc_url` ride along as
 * metrics and never change `passed`.
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
      await checkCustomersIntact(ctx, stack),
      await checkSignupInsertWorks(ctx, stack),
    ];
    return scoreWithDocUrlMetrics(gating, ctx.toolCalls, ARTICLE_URL);
  } catch (error) {
    return scorerFailure('resolve-cli-002-sequence-out-of-sync', error);
  }
};

export default scorer;

export const CUSTOMERS_CHECK = 'the seeded customers are still there';
export const SIGNUP_CHECK = 'a new customer can be added without an id';

/** Passes when every seeded customer still has its original id and email. */
export async function checkCustomersIntact(
  ctx: Pick<Ctx, 'exec'>,
  stack: StackProbe
): Promise<CheckResult> {
  const run = await runSql(ctx, stack, SEEDED_CUSTOMERS_SQL, {
    fieldSeparator: '|',
  });
  if (!run.ok)
    return { name: CUSTOMERS_CHECK, passed: false, notes: run.notes };
  const lines = run.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const missing = SEEDED_CUSTOMERS.filter((row) => !lines.includes(row));
  return {
    name: CUSTOMERS_CHECK,
    passed: missing.length === 0,
    notes:
      missing.length === 0
        ? `${SEEDED_CUSTOMERS.length} seeded customers present`
        : `missing or changed: ${missing.join(', ')}`,
  };
}

/** Runs the signup job's insert shape (no id) twice in a rolled-back transaction. */
export async function checkSignupInsertWorks(
  ctx: Pick<Ctx, 'exec'>,
  stack: StackProbe
): Promise<CheckResult> {
  const run = await runSql(ctx, stack, SIGNUP_INSERT_SQL);
  return {
    name: SIGNUP_CHECK,
    passed: run.ok,
    notes: run.ok ? 'two inserts without an id succeeded' : run.notes,
  };
}
