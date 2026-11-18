import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
} from '@supabase-evals/core';
import type { SparkScoringContext } from '../../../experiments/spark/lib/runtime.js';
import { checkNoRawSql } from '../../../experiments/spark/lib/scoring.js';

// Spark port of the benchmark build-dataapi-001 scenario: the prompt asks the
// agent to finish a backend reporting script (`app/report.mjs`) over a seeded
// relational schema (customers → orders → order_items → products) and never
// names supabase-js — the "uses @supabase/supabase-js" check is GATING, and
// shelling out to psql / a raw Postgres driver instead fails. Expected numbers
// are computed from the project's own rows at scoring time, so the seed stays
// the single source of truth.

const APP_DIR = 'app';
const REPORT = 'report.mjs';

interface ReportRow {
  customer: unknown;
  orderCount: unknown;
  totalCents: unknown;
  topProduct: unknown;
}

const EXPECTED_SQL = `
with per_product as (
  select c.name as customer, p.name as product,
         sum(oi.quantity)::int as units
    from public.customers c
    join public.orders o on o.customer_id = c.id
    join public.order_items oi on oi.order_id = o.id
    join public.products p on p.id = oi.product_id
   group by c.name, p.name
), totals as (
  select c.name as customer,
         count(distinct o.id)::int as order_count,
         sum(oi.quantity * p.price_cents)::int as total_cents
    from public.customers c
    join public.orders o on o.customer_id = c.id
    join public.order_items oi on oi.order_id = o.id
    join public.products p on p.id = oi.product_id
   group by c.name
)
select t.customer,
       t.order_count,
       t.total_cents,
       (select pp.product
          from per_product pp
         where pp.customer = t.customer
         order by pp.units desc, pp.product asc
         limit 1) as top_product
  from totals t
 order by t.customer asc
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
      customer: row.customer,
      orderCount: row.order_count,
      totalCents: row.total_cents,
      topProduct: row.top_product,
    }));
    const normalized = (actual ?? []).map((row) => ({
      customer: row.customer,
      orderCount: row.orderCount,
      totalCents: row.totalCents,
      topProduct: row.topProduct,
    }));
    checks.push({
      name: 'report numbers match the database (per customer, sorted)',
      passed: JSON.stringify(normalized) === JSON.stringify(expected),
      notes: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(normalized)}`,
    });

    // The tables are backend-only: the right fix is the secret key in the
    // worker, not opening them up to client keys.
    // Spark reports the denied read as an error rather than empty data.
    const probe = await ctx.getClient().from('customers').select('id');
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

function parseReport(stdout: string): ReportRow[] | undefined {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1));
    return Array.isArray(parsed) ? (parsed as ReportRow[]) : undefined;
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
