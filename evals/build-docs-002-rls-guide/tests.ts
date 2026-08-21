import {
  judge,
  type CheckResult,
  type LocalStackEvalContext,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

/** Allow + deny for four operations across two roles is eight assertions. */
const MIN_PGTAP_TESTS = 8;

const SUITE_TOTAL = /Files=\d+,\s*Tests=(\d+)/;
const SUITE_FAILED = /\bFailed:\s*(\d+)/i;

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
  const result = await ctx.exec('supabase test db', { timeoutMs: 180_000 });
  const output = result.stdout + result.stderr;

  const summary = SUITE_TOTAL.test(result.stdout) ? result.stdout : output;
  const totalMatch = summary.match(SUITE_TOTAL);
  const failedMatch = summary.match(SUITE_FAILED);
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

/** A low bar on purpose: determining a great quality of tests is a tall order for low-effort agents */
export async function checkTestsExerciseAccessControl(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name =
    'the pgTAP tests exercise access control on the application tables rather than standing in as placeholders';
  const files = await listTestFiles(ctx);
  if (files.length === 0) {
    return { name, passed: false, notes: 'no test files to review' };
  }

  const sources = await Promise.all(
    files.map(async (file) => `-- ${file}\n${await ctx.readFile(file)}`)
  );

  const verdict = await judge({
    input: sources.join('\n\n'),
    rubric: stripIndent`
      You are reviewing pgTAP tests for a Postgres database holding a to-do app
      (\`todos\`, \`lists\`, \`list_members\`, \`list_items\`) and a public
      weather feed (\`weather_stations\`, \`weather_readings\`).

      This is a low bar. Writing a real Row Level Security test earns a pass.
      Do not grade thoroughness, breadth, or style.

      Pass when all three hold:
      - An assertion runs against one of those tables, not only against scratch
        tables the suite made for itself.
      - Something is asserted to be allowed, and something to be denied.
      - A role or identity is set at least once, such as \`set local role\` or
        \`set local request.jwt.claims\`.

      Partial coverage of tables, roles, and operations is fine. So is proving
      an allowed write with \`lives_ok\` alone, without checking that state
      changed or that a \`using\`-filtered row is intact. Any assertion style
      counts.

      Fail only when nothing about access control is asserted, such as
      \`ok(true)\` placeholders or assertions that never touch those tables.
      On a close call, pass.
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
