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

/**
 * A deliberately low bar. Tests are the bonus in this eval, so this credits
 * writing a real RLS test at all and does not grade craft. Earlier versions
 * required all six tables, allow and deny per operation, and state
 * verification on allowed writes; each of those redded the whole eval over the
 * bonus while every RLS check was green.
 */
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
      You are reviewing pgTAP test files written against a Postgres database
      that holds a to-do app (\`todos\`, \`lists\`, \`list_members\`,
      \`list_items\`) and a public weather feed (\`weather_stations\`,
      \`weather_readings\`).

      This is a deliberately low bar. Writing a real Row Level Security test at
      all is what earns a pass. Do not grade thoroughness, breadth, or style.

      Pass if all of these hold:
      - At least one assertion runs against one of the application's own tables
        above, rather than only against scratch tables the suite created for
        itself.
      - At least one assertion expects access to be allowed, and at least one
        expects access to be denied.
      - The suite sets a role or an identity at least once, for example with
        \`set local role\`, \`set local request.jwt.claims\`, or
        \`set local request.jwt.claim.sub\`.

      Explicitly acceptable, and never a reason to fail:
      - Covering only some of the six tables.
      - Covering only one role.
      - Proving an allowed write with \`lives_ok\` and nothing else.
      - Not verifying that an allowed write changed state.
      - Not checking that a row filtered out by a \`using\` clause is intact.
      - Missing some of select, insert, update, or delete.
      - Any assertion style, including results_eq, is, ok, lives_ok,
        throws_ok, and policies_are, plus helper wrappers around them.

      Fail only when the suite asserts nothing about access control. Examples
      of a fail: a file of \`select ok(true)\` placeholders, assertions that
      never touch the application's tables, or a suite with no allowed case or
      no denied case anywhere.

      When it is a close call, pass.
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
