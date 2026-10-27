import {
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';

// Flutter port of build-dataapi-001-relational-report: the prompt asks the
// agent to finish the data layer of a staff sales dashboard over a seeded
// relational schema (customers → orders → order_items → products) and never
// names supabase_flutter. The starter app has no dependencies besides Flutter
// (mirroring the JS starter's empty package.json), so the agent has to
// discover and add the SDK itself; the "uses supabase_flutter" check is
// GATING. Unlike the JS and Python workers, a Flutter app is client code: it
// only gets the publishable key, so the agent has to let signed-in staff read
// the tables (grants and RLS policies) without opening them to anonymous
// users or shipping the secret key. Expected numbers are computed from the
// database at scoring time, so the seed stays the single source of truth.

const APP_DIR = 'app';
const TEST_FILE = 'test/eval_sales_report_test.dart';
const REPORT_MARKER = 'EVAL_REPORT ';
const STAFF_PASSWORD = 'eval-staff-password';
const TABLES = ['customers', 'products', 'orders', 'order_items'];

// Drives the app's own data layer the way main.dart does: connect with the
// publishable key, sign in as a staff member, load the report. `flutter test`
// has no platform plugins, so the shared_preferences channel that
// supabase_flutter persists the session through is answered in memory, and the
// test binding's fake HttpClient is switched off so requests reach the stack.
const SCORER_TEST = `import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sales_dashboard/sales_report.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(
        const MethodChannel('plugins.flutter.io/shared_preferences'),
        (call) async => call.method == 'getAll' ? <String, Object>{} : true,
      );

  test('sales report as a signed-in staff member', () async {
    HttpOverrides.global = null;
    final env = Platform.environment;
    await connect(
      url: env['EVAL_SUPABASE_URL']!,
      publishableKey: env['EVAL_SUPABASE_PUBLISHABLE_KEY']!,
    );
    await signIn(
      email: env['EVAL_STAFF_EMAIL']!,
      password: env['EVAL_STAFF_PASSWORD']!,
    );
    final rows = await loadSalesReport();
    stdout.writeln('${REPORT_MARKER}\${jsonEncode(rows)}');
  });
}
`;

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
    const status = await ctx.stackStatus();

    // Scanned before the scorer adds its own test file, which names no key.
    const secretScan = await ctx.exec(
      `grep -rlE --exclude-dir=.dart_tool --exclude-dir=build ` +
        `"${status.secretKey}|sb_secret_|service_role" ${APP_DIR} || true`
    );

    // Be generous about a missing install step; the eval is about the report,
    // not packaging. A no-op when the agent already resolved dependencies.
    const install = await ctx.exec(`cd ${APP_DIR} && flutter pub get`, {
      timeoutMs: 300_000,
    });
    if (!install.ok) {
      return fail(
        'installed app dependencies',
        install.stderr.trim() || install.stdout.trim()
      );
    }

    // Sign-ups are off, so the staff account comes from the admin API, the
    // way an admin would create it.
    const staffEmail = `eval-staff-${Date.now()}@example.com`;
    const staff = await fetch(`${status.apiUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: status.secretKey,
        Authorization: `Bearer ${status.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: staffEmail,
        password: STAFF_PASSWORD,
        email_confirm: true,
      }),
    });
    if (!staff.ok) {
      return fail(
        'created a staff account',
        `admin API returned ${staff.status}: ${preview(await staff.text())}`
      );
    }

    const writeTest = await ctx.exec(
      `mkdir -p ${APP_DIR}/test && printf '%s' '${Buffer.from(SCORER_TEST).toString('base64')}' | base64 -d > ${APP_DIR}/${TEST_FILE}`
    );
    if (!writeTest.ok) {
      return fail('wrote the scorer test', writeTest.stderr.trim());
    }

    const run = await ctx.exec(
      `cd ${APP_DIR} && EVAL_SUPABASE_URL="${status.apiUrl}" ` +
        `EVAL_SUPABASE_PUBLISHABLE_KEY="${status.publishableKey}" ` +
        `EVAL_STAFF_EMAIL="${staffEmail}" EVAL_STAFF_PASSWORD="${STAFF_PASSWORD}" ` +
        `flutter test --reporter expanded ${TEST_FILE}`,
      { timeoutMs: 300_000 }
    );
    const actual = parseReport(run.stdout);
    checks.push({
      name: 'report loads for a signed-in staff member',
      passed: run.ok && actual !== undefined,
      notes:
        actual !== undefined
          ? `exit ${run.exitCode}`
          : `no report in test output: ${preview(run.stdout + run.stderr)}`,
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

    // Staff access must come from signing in, not from opening the tables to
    // anyone holding the publishable key.
    const client = await ctx.getClient();
    const leaks: string[] = [];
    for (const table of TABLES) {
      const probe = await client.from(table).select('*');
      const count = (probe.data ?? []).length;
      if (count > 0) leaks.push(`${table} (${count} rows)`);
    }
    checks.push({
      name: 'tables stay closed to anonymous users',
      passed: leaks.length === 0,
      notes:
        leaks.length > 0
          ? `publishable key without a session read ${leaks.join(', ')}`
          : 'publishable key without a session reads nothing',
    });

    checks.push({
      name: 'app does not ship the secret key',
      passed: secretScan.stdout.trim() === '',
      notes:
        secretScan.stdout.trim().replace(/\s+/g, ', ') ||
        'no secret key or service_role reference in the app',
    });

    // GATING: the data layer must be built on supabase_flutter, even though
    // the prompt never names it…
    checks.push(await sdkUsageCheck(ctx));

    // …and must actually query through the Data API, not a raw Postgres
    // driver.
    const rawSqlScan = await ctx.exec(
      `grep -rlE --exclude-dir=.dart_tool --exclude-dir=build --include='*.dart' --include='pubspec.yaml' ` +
        `"package:postgres|^\\s*postgres:" ${APP_DIR} || true`
    );
    checks.push({
      name: 'app queries via the Data API, not raw SQL',
      passed: rawSqlScan.stdout.trim() === '',
      notes:
        rawSqlScan.stdout.trim().replace(/\s+/g, ', ') ||
        'no raw Postgres driver usage found',
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
  const start = stdout.indexOf(REPORT_MARKER);
  if (start === -1) return undefined;
  const line = stdout.slice(start + REPORT_MARKER.length).split('\n')[0];
  try {
    const parsed = JSON.parse(line);
    return Array.isArray(parsed) ? (parsed as ReportRow[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * GATING: some file in lib/ must genuinely import supabase_flutter: a
 * `package:supabase_flutter/…` import at the start of a non-comment line.
 */
async function sdkUsageCheck(ctx: LocalStackEvalContext): Promise<CheckResult> {
  const NAME = 'implementation uses supabase_flutter';
  const scan = await ctx.exec(
    `grep -rnE --include='*.dart' ` +
      `"^\\s*import\\s+['\\"]package:supabase_flutter/" ${APP_DIR}/lib || true`
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
        : 'no supabase_flutter import found in lib/; this eval requires the SDK',
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
