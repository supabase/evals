import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';

import {
  checkMemberCannotDeleteAnothersPost,
  checkMemberCannotSelfPromote,
  checkMemberDeletesOwnPost,
  checkModeratorDeletesAnyPost,
  checkRoleReachesTheToken,
  type Probes,
  setupProbes,
} from './probes.js';
import {
  checkHookIsEnabled,
  checkStackIsRunning,
  readStackState,
} from './stack.js';

const GUIDE_PATH = 'custom-claims-and-role-based-access-control-rbac';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const stack = await readStackState(ctx);
    const hook = await checkHookIsEnabled(ctx);

    const setup = stack.running
      ? await setupProbes(ctx)
      : { failure: 'the agent left the local stack down' };
    const probes = 'probes' in setup ? setup.probes : undefined;
    const blocked = 'failure' in setup ? setup.failure : undefined;

    const checks: CheckResult[] = [
      checkStackIsRunning(stack),
      hook,
      await gated(
        probes,
        blocked,
        "the moderator's role travels in their token and a member's does not",
        async (p) => checkRoleReachesTheToken(p)
      ),
      await gated(probes, blocked, 'a member can delete their own post', (p) =>
        checkMemberDeletesOwnPost(ctx, p)
      ),
      await gated(
        probes,
        blocked,
        "a member cannot delete another member's post",
        (p) => checkMemberCannotDeleteAnothersPost(ctx, p)
      ),
      await gated(
        probes,
        blocked,
        "a moderator can delete another member's post",
        (p) => checkModeratorDeletesAnyPost(ctx, p)
      ),
      await gated(
        probes,
        blocked,
        'a member cannot make themselves a moderator',
        (p) => checkMemberCannotSelfPromote(ctx, p)
      ),
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated who may delete a post',
          passed: false,
          notes: message,
        },
      ],
    };
  }
};

export default scorer;

async function gated(
  probes: Probes | undefined,
  blocked: string | undefined,
  name: string,
  probe: (probes: Probes) => Promise<CheckResult>
): Promise<CheckResult> {
  if (!probes) {
    return { name, passed: false, notes: `not run: ${blocked ?? 'no probes'}` };
  }
  return probe(probes);
}

function checkGuideWasRead(ctx: LocalStackEvalContext): CheckResult {
  const calls = buildDocsResult(ctx.toolCalls).calls.filter((call) =>
    call.pages?.some((page) => page.url.includes(GUIDE_PATH))
  );
  const withContent = calls.filter((call) => call.hasContent);
  return {
    name: 'the agent read the Custom Claims and RBAC guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
