import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { REFRESH_SCRIPT, type Refresh, refreshAfterChange } from './refresh.js';
import { type Analysis, analyze, PROBE } from './typecheck.js';

const GUIDE_PATH = 'guides/api/rest/generating-types';
const CONTROL_NOTE =
  'a known-bad control raised no error, so the types could not be judged';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const snapshot = analyze(ctx.hostWorkspace);
    const refreshed = await refreshAfterChange(ctx);

    const checks: CheckResult[] = [
      checkAppTypeChecks(snapshot),
      checkTypesMatchSchema(snapshot),
      checkRefreshFollowsChange(refreshed),
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated the database types',
          passed: false,
          notes: message,
        },
      ],
    };
  }
};

export default scorer;

function checkAppTypeChecks(analysis: Analysis): CheckResult {
  const name =
    'the app type-checks in strict mode with no suppression comments';
  if (!analysis.ok) return { name, passed: false, notes: analysis.reason };
  const { appDiagnostics, suppressions } = analysis;
  const problems = [
    appDiagnostics.length > 0
      ? `${appDiagnostics.length} diagnostics: ${appDiagnostics.slice(0, 5).join('; ')}`
      : '',
    suppressions.length > 0
      ? `suppression comments at ${suppressions.slice(0, 5).join(', ')}`
      : '',
  ].filter((problem) => problem.length > 0);
  return {
    name,
    passed: problems.length === 0,
    notes:
      problems.length === 0
        ? 'no diagnostics with strict mode forced on, and no @ts-ignore, @ts-expect-error or @ts-nocheck'
        : problems.join('; '),
  };
}

function checkTypesMatchSchema(analysis: Analysis): CheckResult {
  const name = 'the types match the local tables and function the app uses';
  if (!analysis.ok) return { name, passed: false, notes: analysis.reason };
  if (analysis.failedProbes.length > 0) {
    return {
      name,
      passed: false,
      notes: `wrong or missing: ${analysis.failedProbes.join(', ')}`,
    };
  }
  if (!analysis.controlFired) {
    return { name, passed: false, notes: CONTROL_NOTE };
  }
  return { name, passed: true, notes: Object.values(PROBE).join(', ') };
}

function checkRefreshFollowsChange(refresh: Refresh): CheckResult {
  const name =
    'the refresh command picks up a new column in the local database';
  if (!refresh.ran) return { name, passed: false, notes: refresh.reason };
  const { analysis, column } = refresh;
  if (!analysis.ok) return { name, passed: false, notes: analysis.reason };
  return {
    name,
    passed: analysis.booksRowMatches,
    notes: analysis.booksRowMatches
      ? `npm run ${REFRESH_SCRIPT} added catalog.books.${column} to the types the app is created with`
      : `after npm run ${REFRESH_SCRIPT}, the types the app is created with do not describe catalog.books with ${column}`,
  };
}

function checkGuideWasRead(ctx: LocalStackEvalContext): CheckResult {
  const calls = buildDocsResult(ctx.toolCalls).calls.filter((call) =>
    call.pages?.some((page) => page.url.includes(GUIDE_PATH))
  );
  const withContent = calls.filter((call) => call.hasContent);
  return {
    name: 'the agent read the generating types guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
