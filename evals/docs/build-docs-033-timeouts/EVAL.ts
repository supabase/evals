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
  checkCutOff,
  checkJobFinishes,
  checkQuickFinishes,
  checkReloaded,
  probeTimeouts,
} from './probes.js';

const GUIDE_PATH = 'guides/database/postgres/timeouts';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    // Pending migrations first, so a role setting written into a migration
    // and never applied costs one check. One round of calls through the Data
    // API then feeds the four checks after it.
    const migrations = await applyPendingMigrations(ctx);
    const probe = await probeTimeouts(ctx);

    const checks: CheckResult[] = [
      checkMigrationsWereApplied(migrations),
      checkReloaded(probe),
      checkQuickFinishes(probe),
      checkCutOff(probe),
      checkJobFinishes(probe),
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated the query timeouts',
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
    name: 'the agent read the timeouts guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
