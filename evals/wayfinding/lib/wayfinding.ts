import {
  scoreWayfinding,
  type CheckResult,
  type ToolEvalContext,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

export const REACHED_TARGET_CHECK = 'reached a target page';

/**
 * Passes when a docs call delivered one of `targets`. The notes carry the
 * wayfinding summary as JSON: entry surface, hops, each fetch with how the
 * agent found it, wrong pages, 404s, and search queries.
 */
export async function checkReachedTarget(
  ctx: Pick<ToolEvalContext, 'toolCalls'>,
  targets: string[]
): Promise<CheckResult> {
  const result = await scoreWayfinding({ toolCalls: ctx.toolCalls, targets });
  return {
    name: REACHED_TARGET_CHECK,
    passed: result.hopsToTarget !== null,
    notes: JSON.stringify(result),
  };
}

/** Rubric for judging whether the agent's final answer covers a task's facts. */
export function factsRubric(facts: string[]): string {
  return stripIndent`
    The input is an agent's final answer to a developer's question about Supabase.
    Pass only if the answer states every fact below, in any wording. An answer
    that says to look something up, or covers a different product feature, fails.

    Facts:
    ${facts.map((fact) => `- ${fact}`).join('\n')}
  `;
}
