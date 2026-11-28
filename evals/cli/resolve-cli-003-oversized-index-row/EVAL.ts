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
  LONG_INSERT_SQL,
  SEEDED_ARTICLES,
  SEEDED_ARTICLES_SQL,
  UNIQUE_BODY_SQL,
} from './fixtures.js';

type Ctx = Parameters<LocalStackScorer>[0];

/**
 * Scores "make publishing a long article work and keep bodies unique". The
 * checks read the live database. `read_doc_url` and `saw_doc_url` ride along
 * as metrics and never change `passed`.
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
      await checkArticlesIntact(ctx, stack),
      await checkLongInsertWorks(ctx, stack),
      await checkBodiesStayUnique(ctx, stack),
    ];
    return scoreWithDocUrlMetrics(gating, ctx.toolCalls, ARTICLE_URL);
  } catch (error) {
    return scorerFailure('resolve-cli-003-oversized-index-row', error);
  }
};

export default scorer;

export const ARTICLES_CHECK = 'the seeded articles are still there';
export const LONG_INSERT_CHECK = 'an article with a 5 KB body can be published';
export const UNIQUE_CHECK = 'the same body is still refused a second time';

/** Passes when every seeded article keeps its slug and title. */
export async function checkArticlesIntact(
  ctx: Pick<Ctx, 'exec'>,
  stack: StackProbe
): Promise<CheckResult> {
  const run = await runSql(ctx, stack, SEEDED_ARTICLES_SQL, {
    fieldSeparator: '|',
  });
  if (!run.ok) return { name: ARTICLES_CHECK, passed: false, notes: run.notes };
  const lines = run.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const missing = SEEDED_ARTICLES.filter((row) => !lines.includes(row));
  return {
    name: ARTICLES_CHECK,
    passed: missing.length === 0,
    notes:
      missing.length === 0
        ? `${SEEDED_ARTICLES.length} seeded articles present`
        : `missing or changed: ${missing.join(', ')}`,
  };
}

/** Inserts a body above the btree limit in a rolled-back transaction. */
export async function checkLongInsertWorks(
  ctx: Pick<Ctx, 'exec'>,
  stack: StackProbe
): Promise<CheckResult> {
  const run = await runSql(ctx, stack, LONG_INSERT_SQL);
  return {
    name: LONG_INSERT_CHECK,
    passed: run.ok,
    notes: run.ok ? 'the long insert succeeded' : run.notes,
  };
}

/** A repeated long body and a repeated short body must both raise a unique violation. */
export async function checkBodiesStayUnique(
  ctx: Pick<Ctx, 'exec'>,
  stack: StackProbe
): Promise<CheckResult> {
  const run = await runSql(ctx, stack, UNIQUE_BODY_SQL);
  return {
    name: UNIQUE_CHECK,
    passed: run.ok,
    notes: run.ok ? 'repeated long and short bodies were refused' : run.notes,
  };
}
