import type {
  CheckResult,
  LocalStackEvalContext,
  LocalStackScorer,
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

function checkGuideWasRead(ctx: LocalStackEvalContext): CheckResult {
  const reads = ctx.toolCalls.filter((call) =>
    [call.url, call.command, call.endpoint, JSON.stringify(call.body ?? {})]
      .filter((value): value is string => typeof value === 'string')
      .some((value) => value.includes(GUIDE_PATH))
  );
  return {
    name: 'the agent read the Row Level Security guide the prompt referenced',
    passed: reads.length > 0,
    notes:
      reads.length > 0
        ? `${reads.length} call(s) referenced the guide`
        : 'no tool call referenced the guide url',
  };
}
