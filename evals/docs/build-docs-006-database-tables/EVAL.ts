import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';

import {
  checkProtectedTablesHavePolicies,
  checkRlsEnabled,
  loadPolicies,
  loadTableState,
} from './catalog.js';
import {
  checkAnonCannotCreateRoutine,
  checkAppTablesAcceptItsRows,
  checkOwnerReadsOwnRoutines,
  checkRoutinesAreHidden,
  checkStarterLibraryIsBrowsable,
  setupFixtures,
  type Fixtures,
} from './access.js';

const GUIDE_PATH = 'guides/database/tables';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    // Snapshot the catalog before anything writes, so no probe can change what
    // the schema checks see.
    const tables = await loadTableState(ctx);
    const policies = await loadPolicies(ctx);

    const setup = await setupFixtures(ctx);
    const fixtures = 'fixtures' in setup ? setup.fixtures : undefined;

    const checks: CheckResult[] = [
      checkAppTablesAcceptItsRows(setup),
      checkRlsEnabled(tables),
      checkProtectedTablesHavePolicies(tables, policies),
      await gated(
        fixtures,
        'a signed-out visitor can browse the starter routine library',
        checkStarterLibraryIsBrowsable
      ),
      await gated(
        fixtures,
        "a signed-out visitor cannot read anyone's routines",
        checkRoutinesAreHidden
      ),
      await gated(
        fixtures,
        "the signed-in owner reads their own routines and nobody else's",
        checkOwnerReadsOwnRoutines
      ),
      // Last of the probes: it writes to `routines` when the schema lets it,
      // and every probe that reads that table has to have run already.
      await gated(
        fixtures,
        'a signed-out visitor cannot create a routine',
        (f) => checkAnonCannotCreateRoutine(ctx, f)
      ),
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated the schema the agent created',
          passed: false,
          notes: message,
        },
      ],
    };
  }
};

export default scorer;

/**
 * Runs a probe, or reports it failed for want of a schema to probe.
 *
 * The name is passed in rather than read off the result so the check list is
 * the same length and carries the same names on every run. A setup failure
 * that collapsed the list instead would be invisible in a summary, and the
 * published series is keyed on these strings.
 */
async function gated(
  fixtures: Fixtures | undefined,
  name: string,
  probe: (fixtures: Fixtures) => Promise<CheckResult>
): Promise<CheckResult> {
  if (!fixtures) {
    return {
      name,
      passed: false,
      notes:
        "not run: the app's tables did not accept the rows its queries write",
    };
  }
  return probe(fixtures);
}

// A search_docs hit carries the guide's url in its result, not its request, so
// reuse the harness's own resolution rather than scanning the raw tool call.
function checkGuideWasRead(ctx: LocalStackEvalContext): CheckResult {
  const calls = buildDocsResult(ctx.toolCalls).calls.filter((call) =>
    call.pages?.some((page) => page.url.includes(GUIDE_PATH))
  );
  const withContent = calls.filter((call) => call.hasContent);
  return {
    name: 'the agent read the Tables and Data guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
