import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import {
  checkButton,
  checkCopy,
  checkHeadsUp,
  checkNickname,
  checkOthers,
  checkSent,
  checkStackStarts,
  checkSubject,
  probeEmails,
  restartStack,
} from './probes.js';

const GUIDE_PATH = 'guides/auth/auth-email-templates';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const started = await restartStack(ctx);
    const probe = await probeEmails(ctx, started);

    const checks: CheckResult[] = [
      checkStackStarts(started),
      checkSent(probe),
      checkSubject(probe),
      checkCopy(probe),
      checkNickname(probe),
      checkButton(probe),
      checkHeadsUp(probe),
      checkOthers(probe),
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated what a new sign-up receives',
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
    name: 'the agent read the email templates guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
