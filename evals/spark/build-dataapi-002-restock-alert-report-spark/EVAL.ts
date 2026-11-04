import {
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';

// SDK adoption is scored even though the prompt does not name supabase-js.

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

const scorer: LocalStackScorer = async (ctx) => {
  const checks: CheckResult[] = [];
  try {
    const status = await ctx.stackStatus();
    const apiUrl = status.apiUrl;
    const secretKey = status.secretKey;
    if (!apiUrl || !secretKey) {
      return fail(
        'read hosted connection settings',
        `missing hosted API URL or secret key; got keys: ${Object.keys(status).join(', ')}`
      );
    }

    // Install dependencies if the agent omitted the install step.
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
          : `no JSON array in output. ${preview(run.stderr || run.stdout)}`,
    });

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

    checks.push(await sdkUsageCheck(ctx));

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

function parseReport(stdout: string): AlertRow[] | undefined {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
    return Array.isArray(parsed) && parsed.every(isAlertRow)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

// Match real imports, including multiline `} from '@supabase/supabase-js'`.
// Exclude commented imports and package-name suffixes like `-not-real`.
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
        : 'no @supabase/supabase-js import found. this eval requires the SDK',
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

function isAlertRow(value: unknown): value is AlertRow {
  return (
    typeof value === 'object' &&
    value !== null &&
    'warehouse' in value &&
    'product' in value &&
    'quantity' in value &&
    'reorderThreshold' in value &&
    'supplierEmail' in value
  );
}
