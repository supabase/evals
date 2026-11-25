import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import {
  checkCharactersRefused,
  checkPolicyAccepted,
  checkShortRefused,
  checkStackStarts,
  probeSignups,
  restartStack,
} from './probes.js';

const GUIDE_PATH = 'guides/auth/passwords';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    // Restart first so Auth runs on the project's settings, whether or not
    // the agent restarted it. One round of sign-ups feeds the three checks
    // after it.
    const started = await restartStack(ctx);
    const probe = await probeSignups(ctx, started);

    const checks: CheckResult[] = [
      checkStackStarts(started),
      checkShortRefused(probe),
      checkCharactersRefused(probe),
      checkPolicyAccepted(probe),
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated which sign-ups the project turns away',
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
    name: 'the agent read the passwords guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
