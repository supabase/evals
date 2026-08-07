import {
  judge,
  type CheckResult,
  type LocalStackEvalContext,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

/** Allow + deny for four operations across two roles is eight assertions. */
const MIN_PGTAP_TESTS = 8;

const REQUIRED_TABLE_GROUPS = [
  ['todos'],
  ['lists', 'list_items'],
  ['weather_readings', 'weather_stations'],
];

export async function checkTestFilesExist(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const files = await listTestFiles(ctx);
  return {
    name: 'pgTAP test file(s) written under supabase/tests/',
    passed: files.length > 0,
    notes:
      files.length > 0
        ? `${files.length} file(s): ${files.join(', ')}`
        : 'no .sql files found under supabase/tests/',
  };
}

// The counts alone are not enough: a suite whose plan does not match the
// assertions it ran reports `Tests: 6 Failed: 0` and still exits non-zero with
// `Result: FAIL`, so the exit status is what decides.
export async function checkPgTapSuitePasses(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const result = await ctx.exec('supabase test db 2>&1', {
    timeoutMs: 180_000,
  });
  const output = result.stdout + result.stderr;

  const totalMatch = output.match(/Tests[=:]\s*(\d+)/i);
  const failedMatch = output.match(/Failed:\s*(\d+)/i);
  const total = totalMatch ? parseInt(totalMatch[1], 10) : 0;
  const failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;
  const ran = total > 0;

  return {
    name: `supabase test db runs at least ${MIN_PGTAP_TESTS} assertions and all pass`,
    passed: result.ok && ran && failed === 0 && total >= MIN_PGTAP_TESTS,
    notes: ran
      ? `${total - failed} passed, ${failed} failed, exit ${result.exitCode}`
      : `no test summary found; exit ${result.exitCode}; output: ${output.slice(0, 500)}`,
  };
}

export async function checkTestCoverage(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name =
    'tests assert allow and deny per operation on the seeded tables, for anon and authenticated';
  const files = await listTestFiles(ctx);
  if (files.length === 0) {
    return { name, passed: false, notes: 'no test files to review' };
  }

  const sources = await Promise.all(
    files.map(async (file) => `-- ${file}\n${await ctx.readFile(file)}`)
  );
  const corpus = sources.join('\n\n').toLowerCase();

  const untested = REQUIRED_TABLE_GROUPS.filter(
    (group) => !group.some((table) => corpus.includes(table))
  );
  if (untested.length > 0) {
    return {
      name,
      passed: false,
      notes: `tests never reference: ${untested.map((group) => group.join('/')).join(', ')}`,
    };
  }

  const verdict = await judge({
    input: sources.join('\n\n'),
    rubric: stripIndent`
      You are reviewing pgTAP test files written to prove that Row Level
      Security policies on a Postgres database behave correctly.

      The database holds a to-do app (\`todos\` private to each user, plus
      \`lists\`, \`list_members\`, and \`list_items\` shared with the members of
      a list) and a public weather feed (\`weather_stations\` and
      \`weather_readings\`, readable by everyone and writable by no client).

      Pass only if the tests, taken together, do all of the following:
      - Exercise the tables above, not scratch tables the suite created for
        itself.
      - Assert both an allowed and a denied outcome for each of select,
        insert, update, and delete.
      - Assert that an allowed write actually changed state, not merely that it
        raised nothing.
      - Cover the \`anon\` role as well as the \`authenticated\` role.
      - Switch role and identity per case, for example with
        \`set local role authenticated;\` and
        \`set local request.jwt.claim.sub = '<uuid>';\`.
      - Where an update or delete is denied because the policy's \`using\`
        clause filters the target row out, assert that the row is unchanged
        rather than that an error was raised. Nothing is raised in that case.

      Expecting an error on a write is correct, and must not be penalised,
      when the denial comes from a \`with check\` violation or from a missing
      grant — both of those really do raise. Any assertion style is
      acceptable, including results_eq, is, ok, lives_ok, throws_ok, and
      policies_are, and helper wrappers around them are fine. Judge coverage,
      not phrasing.

      Fail if the tests only cover the happy path, only cover one role, never
      switch identity between cases, assert that a \`using\`-filtered update or
      delete raises an error, or prove an allowed write only by the absence of
      an error.
    `,
  });

  return { name, passed: verdict.passed, judgeNotes: verdict.notes };
}

export async function listTestFiles(
  ctx: LocalStackEvalContext
): Promise<string[]> {
  const result = await ctx.exec(
    "find supabase/tests -name '*.sql' 2>/dev/null"
  );
  return result.stdout.trim().split('\n').filter(Boolean);
}
