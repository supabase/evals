import {
  judge,
  serializeTranscript,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkTestFilesExist(ctx),
      ...(await checkTestResults(ctx)),
      await checkAgentDiagnosis(ctx),
    ];
    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        { name: 'scorer evaluated pgTAP tests', passed: false, notes: msg },
      ],
    };
  }
};

export default scorer;

async function checkTestFilesExist(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'pgTAP test file(s) written under supabase/tests/';
  const result = await ctx.exec(
    "find supabase/tests -name '*.sql' 2>/dev/null"
  );
  const files = result.stdout.trim().split('\n').filter(Boolean);
  return {
    name,
    passed: files.length > 0,
    notes:
      files.length > 0
        ? `${files.length} file(s): ${files.join(', ')}`
        : 'no .sql files found under supabase/tests/',
  };
}

async function checkAgentDiagnosis(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
    rubric: stripIndent`
      Pass if the agent correctly identifies that the \`posts\` table has a broken
      tenant isolation policy — specifically that authenticated members can read
      posts belonging to organizations they are not a member of — and grounds
      this in the test results. The agent does not need to supply the exact SQL
      fix, but must identify \`posts\` (not \`notes\`) as the table with the policy
      flaw, and treat the pgTAP results as the authoritative signal rather than
      dismissing them or trusting the migration comments.

      Fail if the agent claims both tables are correctly isolated, blames \`notes\`
      instead of \`posts\`, attributes all failures to test bugs without suspecting
      the policy, or reports the test results without drawing the correct conclusion
      about which table is broken.
    `,
  });
  return {
    name: 'agent correctly identifies the posts isolation bug from test results',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}

async function checkTestResults(
  ctx: LocalStackEvalContext
): Promise<CheckResult[]> {
  const result = await ctx.exec('supabase test db 2>&1', {
    timeoutMs: 120_000,
  });
  const output = result.stdout + result.stderr;

  // pg_prove summary line: "Files=1, Tests=4, 1 failed." or "Files=1, Tests=4, 0 failed."
  const totalMatch = output.match(/Tests[=:]\s*(\d+)/i);
  const failedMatch = output.match(/Failed:\s*(\d+)/i);
  const totalTests = totalMatch ? parseInt(totalMatch[1], 10) : 0;
  const failedTests = failedMatch ? parseInt(failedMatch[1], 10) : 0;
  const passedTests = totalTests - failedTests;
  const ranTests = totalTests > 0;

  const summary = ranTests
    ? `${passedTests} passed, ${failedTests} failed`
    : `no test summary found; exit ${result.exitCode}; output: ${output.slice(0, 500)}`;

  // Assert the agent wrote and ran a real pgTAP suite with passing tests. We
  // deliberately do NOT gate on the failed-count: whether the negative case
  // surfaces as a *failing* test (assert correct isolation → fails on the buggy
  // posts policy) or a *passing* characterization test (assert the current leak)
  // is a valid style choice. The diagnosis judge below is the authoritative
  // signal that the agent caught the posts bug from the results.
  return [
    {
      name: 'pgTAP isolation tests ran and pass',
      passed: ranTests && passedTests > 0,
      notes: summary,
    },
  ];
}
