import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { restartStack } from '../lib/local-stack.js';
import { checkSealed, sealedNotRun } from './access.js';
import {
  applyPendingMigrations,
  checkMigrationsWereApplied,
} from './migrations.js';
import {
  checkConfirms,
  checkQueued,
  checkReset,
  checkStackStarts,
  probeEmails,
} from './probes.js';

const GUIDE_PATH = 'guides/auth/auth-hooks/send-email-hook';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const started = await restartStack(ctx);
    const migrations = await applyPendingMigrations(ctx);
    const probe = await probeEmails(ctx, started);
    const sealed = probe.stack
      ? await checkSealed(ctx, probe.stack, probe.requests?.userId ?? '')
      : sealedNotRun(probe.message);

    const checks: CheckResult[] = [
      checkStackStarts(started),
      checkMigrationsWereApplied(migrations),
      checkQueued(probe),
      checkConfirms(probe),
      checkReset(probe),
      sealed,
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated how Auth emails reach the outbox',
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
    name: 'the agent read the send email hook guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
