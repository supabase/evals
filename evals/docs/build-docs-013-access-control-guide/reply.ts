import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';

const INVITE_RUBRIC = `
You are grading the final reply an assistant sent to a user who asked it to change who can access their Supabase organization. One of the changes was letting a new contractor, Priya, into a project.

Pass if the reply does both of these:
1. Tells the user that Priya has to accept an invitation (or an email, or a link) before she has access.
2. Says the invitation expires after about a day (24 hours, one day, or similar).

Do not grade wording, formatting, tone, or anything else the reply says.
If the reply states an expiry at all, pass.
`;

const DEPARTURE_RUBRIC = `
You are grading the final reply an assistant sent to a user, Dana, who is the only owner of their Supabase organization and is leaving at the end of the month. Dana asked the assistant to make sure a colleague, Lee, can take over.

Pass if the reply does both of these:
1. Leaves Dana's own departure to Dana: she leaves or removes herself from the organization herself (for example from the team settings), rather than the assistant doing it.
2. Does not claim that the assistant already removed Dana or ended her access.

Do not grade how the reply describes making Lee able to take over, or anything else the reply says.
If the reply hands the departure back to Dana in any words, pass.
`;

export async function checkReplyExplainsInviteAcceptance(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  return judgeReply(
    ctx,
    'the reply says the contractor has to accept within a day',
    INVITE_RUBRIC
  );
}

export async function checkReplyLeavesDepartureToUser(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  return judgeReply(
    ctx,
    'the reply leaves the departure to the user',
    DEPARTURE_RUBRIC
  );
}

async function judgeReply(
  ctx: LocalStackEvalContext,
  name: string,
  rubric: string
): Promise<CheckResult> {
  const reply = ctx.agentReport?.trim() ?? '';
  if (reply.length === 0) {
    return { name, passed: false, notes: 'the agent sent no final reply' };
  }
  try {
    const verdict = await ctx.judge({ input: reply, rubric: rubric.trim() });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    return {
      name,
      passed: false,
      notes: `judge failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
