import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import {
  checkAuthCallsWrapped,
  checkGrants,
  checkHelperIsSafe,
  checkListItemsAvoidsJoin,
  checkLookupTableNotForced,
  checkOnePolicyPerOperation,
  checkPolicyColumnsIndexed,
  checkPoliciesScopedToRole,
  checkRlsEnabled,
  checkUpdatePoliciesHaveBothClauses,
  loadPolicies,
  loadPrivateFunctions,
  loadTableState,
} from './catalog.js';
import {
  checkSharedListAccess,
  checkTodoVisibility,
  checkTodoWrites,
  checkWeatherFeed,
  setupFixtures,
} from './access.js';
import {
  checkPgTapSuitePasses,
  checkTestCoverage,
  checkTestFilesExist,
} from './tests.js';

const GUIDE_PATH = 'guides/database/postgres/row-level-security';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    // Snapshot the catalog before running the agent's pgTAP suite, so nothing
    // a test leaves behind can change what the schema checks see.
    const tables = await loadTableState(ctx);
    const policies = await loadPolicies(ctx);
    const functions = await loadPrivateFunctions(ctx);

    const setup = await setupFixtures(ctx);
    if ('failure' in setup) {
      return { passed: false, checks: [setup.failure] };
    }
    const fixtures = setup.fixtures;

    const checks: CheckResult[] = [
      checkRlsEnabled(tables),
      checkLookupTableNotForced(tables),
      checkPoliciesScopedToRole(policies),
      checkOnePolicyPerOperation(policies),
      checkUpdatePoliciesHaveBothClauses(policies),
      ...(await checkGrants(ctx)),
      ...(await checkTodoVisibility(fixtures)),
      ...(await checkTodoWrites(ctx, fixtures)),
      ...(await checkSharedListAccess(ctx, fixtures)),
      ...(await checkWeatherFeed(ctx, fixtures)),
      checkAuthCallsWrapped(policies),
      await checkPolicyColumnsIndexed(ctx),
      checkListItemsAvoidsJoin(policies),
      checkHelperIsSafe(policies, functions),
      await checkTestFilesExist(ctx),
      await checkPgTapSuitePasses(ctx),
      await checkTestCoverage(ctx),
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated RLS policies and tests',
          passed: false,
          notes: msg,
        },
      ],
    };
  }
};

export default scorer;

// A search_docs hit carries the guide's url in its result, not its request, so
// reuse the harness's own resolution rather than scanning the raw tool call.
function checkGuideWasRead(ctx: LocalStackEvalContext): CheckResult {
  const calls = buildDocsResult(ctx.toolCalls).calls.filter((call) =>
    call.pages?.some((page) => page.url.includes(GUIDE_PATH))
  );
  const withContent = calls.filter((call) => call.hasContent);
  return {
    name: 'the agent read the Row Level Security guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? `${withContent.map((call) => call.source).join(', ')}`
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
