import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { restartStack } from '../lib/local-stack.js';
import {
  checkCode,
  checkNoLink,
  checkSignsIn,
  checkStackStarts,
  probeSignIn,
} from './probes.js';

const GUIDE_PATH = 'guides/auth/auth-email-passwordless';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const started = await restartStack(ctx);
    const probe = await probeSignIn(ctx, started);

    const checks: CheckResult[] = [
      checkStackStarts(started),
      checkCode(probe, 'returning'),
      checkNoLink(probe, 'returning'),
      checkSignsIn(probe, 'returning'),
      checkCode(probe, 'firstTime'),
      checkNoLink(probe, 'firstTime'),
      checkSignsIn(probe, 'firstTime'),
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated how people sign in by email',
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
    name: 'the agent read the passwordless email guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
