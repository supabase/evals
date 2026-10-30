import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { checkSeededPoliciesUnchanged } from './policies.js';
import {
  checkPgTapSuitePasses,
  checkSuiteCatchesOpenRead,
  checkTestsExerciseAccessControl,
  checkTestFilesExist,
  runPgTapSuite,
} from './tests.js';

const GUIDE_PATH = 'guides/database/postgres/testing-row-level-security';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const policies = await checkSeededPoliciesUnchanged(ctx);
    const testFiles = await checkTestFilesExist(ctx);
    const accessControl = await checkTestsExerciseAccessControl(ctx);

    const suite = await runPgTapSuite(ctx);
    const todosCaught = await checkSuiteCatchesOpenRead(
      ctx,
      suite,
      'todos',
      'the suite fails when any signed-in user can read every todo'
    );
    const listItemsCaught = await checkSuiteCatchesOpenRead(
      ctx,
      await runPgTapSuite(ctx),
      'list_items',
      'the suite fails when any signed-in user can read every list item'
    );

    const checks: CheckResult[] = [
      policies,
      testFiles,
      accessControl,
      checkPgTapSuitePasses(suite),
      todosCaught,
      listItemsCaught,
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
