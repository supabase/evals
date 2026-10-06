import {
  scoreWayfinding,
  type CheckResult,
  type ToolEvalContext,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

export const REACHED_TARGET_CHECK = 'reached a target page';

/**
 * Passes when a docs call delivered one of `targets`, or one of
 * `alternates`, duplicates that answer the task just as well. The notes carry
 * the wayfinding summary as JSON: entry surface, hops, each fetch with how the
 * agent found it, other pages, 404s, and search queries.
 */
export async function checkReachedTarget(
  ctx: Pick<ToolEvalContext, 'toolCalls'>,
  targets: string[],
  alternates: string[] = []
): Promise<CheckResult> {
  const result = await scoreWayfinding({
    toolCalls: ctx.toolCalls,
    targets,
    alternates,
  });
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
    Pass only if the answer covers every fact below. Judge substance, not
    wording: a fact is covered when the answer's instructions state it or
    plainly depend on it. Text in parentheses is context for you, not a
    requirement. An answer that says to look something up, or covers a
    different product feature, fails.

    Facts:
    ${facts.map((fact) => `- ${fact}`).join('\n')}
  `;
}
