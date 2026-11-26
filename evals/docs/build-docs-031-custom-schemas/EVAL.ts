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
  CHECK,
  checkLater,
  checkServer,
  checkStackStarts,
  checkStaff,
  checkVisitor,
  probeApi,
} from './probes.js';

const GUIDE_PATH = 'guides/api/using-custom-schemas';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    // Phase order matters. The agent's migrations go in first, so SQL left
    // unapplied costs one check rather than all of them. Then the stack
    // restarts, because the API reads which schemas to expose when it starts
    // and an agent that edited the config without restarting has still said
    // what the project exposes. The API is probed last, once, so every check
    // reads the same answers.
    const migrations = await applyPendingMigrations(ctx);
    const starts = await checkStackStarts(ctx);

    const probe = starts.passed ? await probeApi(ctx) : undefined;
    const api = probe
      ? [
          checkVisitor(probe),
          checkServer(probe),
          checkLater(probe),
          checkStaff(probe),
        ]
      : [CHECK.visitor, CHECK.server, CHECK.later, CHECK.staff].map((name) => ({
          name,
          passed: false,
          notes: 'not run: the stack did not start',
        }));

    const checks: CheckResult[] = [
      checkMigrationsWereApplied(migrations),
      starts,
      ...api,
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated what the Data API reaches',
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
    name: 'the agent read the custom schemas guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
