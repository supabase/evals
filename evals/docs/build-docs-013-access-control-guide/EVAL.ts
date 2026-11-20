import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';

import {
  checkReplyExplainsInviteAcceptance,
  checkReplyLeavesDepartureToUser,
} from './reply.js';
import {
  checkAuditorCannotChangeAnything,
  checkAuditorSeesEveryProject,
  checkContractorKeptOutOfProduction,
  checkContractorWasInvited,
  checkContractorWorksOnStaging,
  checkCurrentOwnerKeepsAccess,
  checkLeeCanRunTheOrganization,
  checkMarcoIsOutOfStaging,
  checkMarcoStillWorksInProduction,
  checkNobodyElseChanged,
  readOrgState,
} from './state.js';

const GUIDE_PATH = 'guides/platform/access-control';

// The organization is read once, after the run, and every state check reads that
// one snapshot, so nothing the scorer does can change what a later check sees. A
// failed read fails the state checks without stopping the reply checks.
const scorer: LocalStackScorer = async (ctx) => {
  try {
    const snapshot = await readOrgState(ctx);

    const checks: CheckResult[] = [
      checkContractorWasInvited(snapshot),
      checkContractorWorksOnStaging(snapshot),
      checkContractorKeptOutOfProduction(snapshot),
      checkAuditorSeesEveryProject(snapshot),
      checkAuditorCannotChangeAnything(snapshot),
      checkMarcoStillWorksInProduction(snapshot),
      checkMarcoIsOutOfStaging(snapshot),
      checkLeeCanRunTheOrganization(snapshot),
      checkCurrentOwnerKeepsAccess(snapshot),
      checkNobodyElseChanged(snapshot),
      await checkReplyExplainsInviteAcceptance(ctx),
      await checkReplyLeavesDepartureToUser(ctx),
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated the organization access changes',
          passed: false,
          notes: message,
        },
      ],
    };
  }
};

export default scorer;

function checkGuideWasRead(ctx: LocalStackEvalContext): CheckResult {
  const calls = buildDocsResult(ctx.toolCalls).calls.filter((call) =>
    call.pages?.some((page) => page.url.includes(GUIDE_PATH))
  );
  const withContent = calls.filter((call) => call.hasContent);
  return {
    name: 'the agent read the access control guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
