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
  checkCannotForge,
  checkInstalled,
  checkLoads,
  checkMemberSees,
  checkNeverSees,
  probeRooms,
} from './probes.js';

const GUIDE_PATH = 'guides/realtime/broadcast';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const migrations = await applyPendingMigrations(ctx);
    const outcome = await probeRooms(ctx);

    const checks: CheckResult[] = [
      checkMigrationsWereApplied(migrations),
      checkInstalled(outcome),
      checkLoads(outcome),
      checkMemberSees(outcome, 'mobile'),
      checkMemberSees(outcome, 'inbox'),
      checkMemberSees(outcome, 'web'),
      checkNeverSees(outcome, 'outsider'),
      checkNeverSees(outcome, 'visitor'),
      checkCannotForge(outcome),
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated who sees new room messages',
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
    name: 'the agent read the Broadcast guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
