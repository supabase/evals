import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
} from '@supabase-evals/core';
import type { SparkScoringContext } from '../../../experiments/spark/lib/runtime.js';
import { checkNoRawSql } from '../../../experiments/spark/lib/scoring.js';

// Spark port of the benchmark build-dataapi-002 scenario, the companion to
// build-dataapi-001: same "unnamed SDK, empty package.json, backend worker
// script" shape, different schema (warehouses → inventory → products →
// suppliers) and aggregation (below-threshold restock alert, not a sales
// rollup). Checks whether the SDK adoption seen in 001 generalizes. The
// "uses @supabase/supabase-js" check is GATING, and shelling out to psql / a
// raw Postgres driver / Spark's SQL endpoint instead fails. Expected alerts
// are computed from the project's own rows at scoring time, so the seed stays
// the single source of truth.

const APP_DIR = 'app';
const REPORT = 'restock.mjs';

interface AlertRow {
  warehouse: unknown;
  product: unknown;
  quantity: unknown;
  reorderThreshold: unknown;
  supplierEmail: unknown;
}

const EXPECTED_SQL = `
select w.name as warehouse,
       p.name as product,
       i.quantity,
       p.reorder_threshold,
       s.email as supplier_email
  from public.inventory i
  join public.warehouses w on w.id = i.warehouse_id
  join public.products p on p.id = i.product_id
  join public.suppliers s on s.id = p.supplier_id
 where i.quantity < p.reorder_threshold
 order by w.name asc, p.name asc
`;

const scorer: ToolScorer = async (ctx) => {
  const checks: CheckResult[] = [];
  try {
    const { sandbox } = ctx;
    if (!sandbox)
      return fail(
        'agent sandbox available',
        'the scorer runs the report in the agent sandbox, but this run had none'
      );
    const { project } = ctx as unknown as SparkScoringContext;

    // Be generous about a missing install step; the eval is about the report,
    // not npm. A no-op when the agent already installed dependencies.
    const install = await sandbox.exec(
      `cd ${APP_DIR} && npm install --no-audit --no-fund --silent`,
      { timeoutMs: 180_000 }
    );
    if (!install.ok) {
      return fail(
        'installed app dependencies',
        install.stderr.trim() || install.stdout.trim()
      );
    }

    const run = await sandbox.exec(`cd ${APP_DIR} && node ${REPORT}`, {
      timeoutMs: 60_000,
      env: {
        SPARK_PROJECT_URL: project.projectUrl,
        SPARK_SECRET_KEY: project.secretKey,
      },
    });
    const actual = parseReport(run.stdout);
    checks.push({
      name: 'report runs and prints JSON',
      passed: run.ok && actual !== undefined,
      notes:
        actual !== undefined
          ? `exit ${run.exitCode}`
          : `no JSON array in output — ${preview(run.stderr || run.stdout)}`,
    });

    // Ground truth straight from the seeded database.
    const { rows } = await ctx.query(EXPECTED_SQL);
    const expected = rows.map((row) => ({
      warehouse: row.warehouse,
      product: row.product,
      quantity: row.quantity,
      reorderThreshold: row.reorder_threshold,
      supplierEmail: row.supplier_email,
    }));
    const normalized = (actual ?? []).map((row) => ({
      warehouse: row.warehouse,
      product: row.product,
      quantity: row.quantity,
      reorderThreshold: row.reorderThreshold,
      supplierEmail: row.supplierEmail,
    }));
    checks.push({
      name: 'alerts match the database (below threshold, sorted)',
      passed: JSON.stringify(normalized) === JSON.stringify(expected),
      notes: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(normalized)}`,
    });

    // The tables are backend-only: the right fix is the secret key in the
    // worker, not opening them up to client keys.
    // Spark reports the denied read as an error rather than empty data.
    const probe = await ctx.getClient().from('inventory').select('id');
    checks.push({
      name: 'tables stay locked down (publishable key reads nothing)',
      passed: !!probe.error || (probe.data ?? []).length === 0,
      notes: probe.error
        ? `publishable read errored: ${probe.error.message}`
        : `publishable read returned ${(probe.data ?? []).length} rows`,
    });

    // GATING: the report must be built on supabase-js, even though the prompt
    // never names it…
    checks.push(await sdkUsageCheck(sandbox));

    // …and must actually query through the Data API, not shell out to psql, a
    // raw Postgres driver or Spark's SQL endpoint.
    checks.push(await checkNoRawSql(sandbox, APP_DIR));

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    checks.push({
      name: 'scorer completed without errors',
      passed: false,
      notes: msg,
    });
    return { passed: false, checks };
  }
};

export default scorer;

function parseReport(stdout: string): AlertRow[] | undefined {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1));
    return Array.isArray(parsed) ? (parsed as AlertRow[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * GATING: some app code file must genuinely import @supabase/supabase-js —
 * the specifier must be closed by a matching quote (so `-not-real` doesn't
 * match) and sit on a `from`/`require(`/`import(` line that isn't commented
 * out. Multi-line named imports still match: the closing `} from '…'` line
 * always carries `from` alongside the specifier.
 */
async function sdkUsageCheck(
  sandbox: NonNullable<ToolEvalContext['sandbox']>
): Promise<CheckResult> {
  const NAME = 'implementation uses @supabase/supabase-js';
  const scan = await sandbox.exec(
    `grep -rnE --exclude-dir=node_modules --include='*.mjs' --include='*.js' --include='*.cjs' --include='*.ts' ` +
      `"(from|require\\(|import\\()\\s*['\\"](npm:)?@supabase/supabase-js['\\"]" ${APP_DIR} ` +
      `| grep -vE ':[0-9]+:\\s*(//|\\*)' || true`
  );
  const files = [
    ...new Set(
      scan.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.slice(0, line.indexOf(':')))
    ),
  ];
  return {
    name: NAME,
    passed: files.length > 0,
    notes:
      files.length > 0
        ? `imports found in: ${files.join(', ')}`
        : 'no @supabase/supabase-js import found — this eval requires the SDK',
  };
}

function preview(body: string): string {
  return body.replace(/\s+/g, ' ').slice(0, 160);
}

function fail(
  name: string,
  notes: string
): { passed: false; checks: CheckResult[] } {
  return { passed: false, checks: [{ name, passed: false, notes }] };
}
