import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { restartStack } from '../lib/local-stack.js';
import {
  checkConfirmedLogIn,
  checkNoNewAccounts,
  checkStackStarts,
  checkStrangersKeptOut,
  checkUnconfirmedLogIn,
  probeAccounts,
} from './probes.js';

const GUIDE_PATH = 'guides/auth/general-configuration';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    // Restart first so Auth runs on the project's settings, whether or not
    // the agent restarted it. The volumes survive, so database fixes count.
    // Then one round of sign-ups and logins feeds checks 2 to 5.
    const started = await restartStack(ctx);
    const probe = await probeAccounts(ctx, started);

    const checks: CheckResult[] = [
      checkStackStarts(started),
      checkNoNewAccounts(probe),
      checkConfirmedLogIn(probe),
      checkUnconfirmedLogIn(probe),
      checkStrangersKeptOut(probe),
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated who can get into the app',
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
    name: 'the agent read the general configuration guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
