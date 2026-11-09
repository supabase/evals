import {
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

export type SuiteRun = {
  ran: boolean;
  passed: boolean;
  total: number;
  failed: number;
  exitCode: number | null;
  output: string;
};

// The counts alone are not enough: a suite whose plan does not match the
// assertions it ran reports `Tests: 6 Failed: 0` and still exits non-zero with
// `Result: FAIL`, so the exit status is what decides.
export async function runPgTapSuite(
  ctx: LocalStackEvalContext
): Promise<SuiteRun> {
  const result = await ctx.exec('supabase test db', { timeoutMs: 180_000 });
  const output = result.stdout + result.stderr;

  const summary = SUITE_TOTAL.test(result.stdout) ? result.stdout : output;
  const totalMatch = summary.match(SUITE_TOTAL);
  const failedMatch = summary.match(SUITE_FAILED);
  const total = totalMatch ? parseInt(totalMatch[1], 10) : 0;
  const failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;
  const ran = total > 0;

  return {
    ran,
    passed: result.ok && ran && failed === 0,
    total,
    failed,
    exitCode: result.exitCode,
    output,
  };
}

export function checkPgTapSuitePasses(run: SuiteRun): CheckResult {
  return {
    name: `supabase test db runs at least ${MIN_PGTAP_TESTS} assertions and all pass`,
    passed: run.passed && run.total >= MIN_PGTAP_TESTS,
    notes: run.ran
      ? `${run.total - run.failed} passed, ${run.failed} failed, exit ${run.exitCode}`
      : `no test summary found; exit ${run.exitCode}; output: ${run.output.slice(0, 500)}`,
  };
}

const OPEN_READ_POLICY = 'eval_open_read';

// A permissive policy ORs with the seeded ones, so adding one opens the read
// without touching what the agent was told to leave alone. The suite has to
// pass just before, so a failure afterwards can only come from the opened read.
export async function checkSuiteCatchesOpenRead(
  ctx: LocalStackEvalContext,
  baseline: SuiteRun,
  table: string,
  name: string
): Promise<CheckResult> {
  if (!baseline.passed) {
    return {
      name,
      passed: false,
      notes:
        'could not measure: the suite does not pass before the read is opened',
    };
  }

  const created = await execSql(
    ctx,
    `CREATE POLICY ${OPEN_READ_POLICY} ON public.${table} FOR SELECT TO authenticated USING (true);`
  );
  if (!created.ok) {
    return {
      name,
      passed: false,
      notes: `could not measure: ${created.message.trim().slice(0, 300)}`,
    };
  }

  let opened: SuiteRun;
  try {
    opened = await runPgTapSuite(ctx);
  } finally {
    await execSql(
      ctx,
      `DROP POLICY IF EXISTS ${OPEN_READ_POLICY} ON public.${table};`
    );
  }

  if (!opened.ran) {
    return {
      name,
      passed: false,
      notes: `could not measure: no test summary found; exit ${opened.exitCode}`,
    };
  }
  return {
    name,
    passed: !opened.passed,
    notes: opened.passed
      ? `all ${opened.total} assertions still passed with the read opened`
      : `${opened.failed} of ${opened.total} assertions failed with the read opened, exit ${opened.exitCode}`,
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

  const verdict = await ctx.judge({
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

async function execSql(
  ctx: LocalStackEvalContext,
  sql: string
): Promise<{ ok: boolean; message: string }> {
  const encoded = Buffer.from(sql, 'utf8').toString('base64');
  const result = await ctx.exec(
    stripIndent`
      DB_URL=$(supabase status -o json | node -e 'let input = ""; process.stdin.on("data", data => input += data); process.stdin.on("end", () => console.log(JSON.parse(input).DB_URL));')
      echo ${encoded} | base64 -d | psql "$DB_URL" -v ON_ERROR_STOP=1
    `
  );
  return {
    ok: result.ok,
    message: result.ok ? '' : result.stderr || result.stdout,
  };
}

export async function listTestFiles(
  ctx: LocalStackEvalContext
): Promise<string[]> {
  const result = await ctx.exec(
    "find supabase/tests -name '*.sql' 2>/dev/null"
  );
  return result.stdout.trim().split('\n').filter(Boolean);
}
