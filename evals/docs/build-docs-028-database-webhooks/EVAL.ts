import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import {
  applyPendingMigrations,
  checkMigrationsWereApplied,
} from './migrations.js';
import {
  checkChanged,
  checkDelivered,
  checkOthers,
  checkShape,
  probeService,
} from './probes.js';

const GUIDE_PATH = 'guides/database/webhooks';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    // Apply what the agent wrote first, so an unapplied migration costs one
    // check rather than all of them. The probe runs once and every check
    // reads the same calls: it adds an order, changes it, then adds a
    // customer, so the silence about customers is read after the control.
    const migrations = await applyPendingMigrations(ctx);
    const probe = await probeService(ctx);

    const checks: CheckResult[] = [
      checkMigrationsWereApplied(migrations),
      checkDelivered(probe),
      checkShape(probe),
      checkChanged(probe),
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
          name: 'scorer evaluated whether a table change reaches the service',
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
    name: 'the agent read the database webhooks guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
