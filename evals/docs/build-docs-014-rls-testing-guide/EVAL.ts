import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import {
  checkPgTapSuitePasses,
  checkTestsExerciseAccessControl,
  checkTestFilesExist,
} from './tests.js';

const GUIDE_PATH = 'guides/database/postgres/testing-row-level-security';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkTestFilesExist(ctx),
      await checkTestsExerciseAccessControl(ctx),
      await checkPgTapSuitePasses(ctx),
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated the RLS policy tests',
          passed: false,
          notes: msg,
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
    name: 'the agent read the RLS testing guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? `${withContent.map((call) => call.source).join(', ')}`
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
