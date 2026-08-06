import {
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';

// Relational-report benchmark for the Data API: the prompt asks the agent to
// finish a backend reporting script over a seeded relational schema
// (customers → orders → order_items → products) and never names supabase-js —
// the "uses @supabase/supabase-js" check is GATING, and shelling out to
// psql / a raw Postgres driver instead fails. Expected numbers are computed
// from the database at scoring time, so the seed stays the single source of
// truth.

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

const scorer: LocalStackScorer = async (ctx) => {
  const checks: CheckResult[] = [];
  try {
    const status = await readStatus(ctx);
    const apiUrl = str(status.API_URL);
    const secretKey = str(status.SECRET_KEY);
    if (!apiUrl || !secretKey) {
      return fail(
        'read stack config from `supabase status`',
        `missing API_URL/SECRET_KEY — is the stack running on a new-enough CLI? got keys: ${Object.keys(status).join(', ')}`
      );
    }

    // Be generous about a missing install step; the eval is about the report,
    // not npm. A no-op when the agent already installed dependencies.
    const install = await ctx.exec(
      `cd ${APP_DIR} && npm install --no-audit --no-fund --silent`,
      { timeoutMs: 180_000 }
    );
    if (!install.ok) {
      return fail(
        'installed app dependencies',
        install.stderr.trim() || install.stdout.trim()
      );
    }

    const run = await ctx.exec(
      `cd ${APP_DIR} && SUPABASE_URL="${apiUrl}" SUPABASE_SECRET_KEY="${secretKey}" node ${REPORT}`,
      { timeoutMs: 60_000 }
    );
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

    // The tables are backend-only: RLS with no policies. The right fix is the
    // secret key in the worker — not opening the tables up to client keys.
    const client = await ctx.getClient();
    const probe = await client.from('customers').select('id');
    checks.push({
      name: 'tables stay locked down (publishable key reads nothing)',
      passed: (probe.data ?? []).length === 0,
      notes: probe.error
        ? `publishable read errored: ${probe.error.message}`
        : `publishable read returned ${(probe.data ?? []).length} rows`,
    });

    // GATING: the report must be built on supabase-js, even though the prompt
    // never names it…
    checks.push(await sdkUsageCheck(ctx));

    // …and must actually query through the Data API, not shell out to psql or
    // a raw Postgres driver.
    const rawSqlScan = await ctx.exec(
      `grep -rlE --exclude-dir=node_modules --include='*.mjs' --include='*.js' --include='*.cjs' --include='*.ts' ` +
        `"psql|['\\"](pg|postgres|pg-promise)['\\"]" ${APP_DIR} || true`
    );
    checks.push({
      name: 'report queries via the Data API, not raw SQL',
      passed: rawSqlScan.stdout.trim() === '',
      notes:
        rawSqlScan.stdout.trim().replace(/\s+/g, ', ') ||
        'no psql / raw Postgres driver usage found',
    });

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
async function sdkUsageCheck(ctx: LocalStackEvalContext): Promise<CheckResult> {
  const NAME = 'implementation uses @supabase/supabase-js';
  const scan = await ctx.exec(
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

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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

/** Parse `supabase status -o json` for the stack's URL and keys. */
async function readStatus(
  ctx: LocalStackEvalContext
): Promise<Record<string, unknown>> {
  const res = await ctx.exec('supabase status -o json');
  const start = res.stdout.indexOf('{');
  const end = res.stdout.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error(
      `could not read \`supabase status\`: ${res.stderr || res.stdout}`
    );
  }
  return JSON.parse(res.stdout.slice(start, end + 1));
}
