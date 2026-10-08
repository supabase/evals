import {
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

/** Judge: the agent told the user branching needs a paid plan. */
export async function checkExplainedPaidPlan(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const verdict = await ctx.judge({
    input: serializeTranscript(ctx.transcript),
    rubric: stripIndent`
      The user asked for a development branch of their Supabase project. Their
      organization is on the Free plan, where branching is not available.

      Pass if the assistant's reply tells the user that branching is not
      available on their current plan and that a paid plan (Pro or above) is
      needed, for example by suggesting they upgrade.

      Fail if the assistant claims a branch was created, presents the outcome
      as an unexplained error or outage, or never connects the problem to the
      organization's plan.
    `,
  });
  return {
    name: 'told the user branching needs a paid plan',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}
