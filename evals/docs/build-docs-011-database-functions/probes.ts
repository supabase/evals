import { randomUUID } from 'node:crypto';
import type {
  CheckResult,
  LocalStackEvalContext,
  SupabaseClient,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

const PASSWORD = 'secret123';
const FUNCTION = 'order_total';
const CUSTOMER_TOTAL = 4330;
const STRANGER_TOTAL = 8660;

export type Probes = {
  anonClient: SupabaseClient;
  customerClient: SupabaseClient;
  customerOrder: number;
  strangerOrder: number;
  argName: string;
};

export type Setup = { probes: Probes } | { failure: string };

export async function setupProbes(
  ctx: LocalStackEvalContext,
  argName: string | undefined
): Promise<Setup> {
  if (!argName) {
    return {
      failure: `no single named argument on ${FUNCTION} to pass an order id to`,
    };
  }

  const run = randomUUID().slice(0, 8);
  const anonClient = await ctx.getClient();
  const customerClient = await ctx.getClient();
  const strangerClient = await ctx.getClient();

  const { data: customer, error: customerError } =
    await customerClient.auth.signUp({
      email: `customer-${run}@example.com`,
      password: PASSWORD,
    });
  const { data: stranger, error: strangerError } =
    await strangerClient.auth.signUp({
      email: `stranger-${run}@example.com`,
      password: PASSWORD,
    });

  if (
    customerError ||
    strangerError ||
    !customer.user?.id ||
    !customer.session ||
    !stranger.user?.id
  ) {
    return {
      failure: `could not sign two customers up: ${customerError?.message ?? strangerError?.message ?? 'no session'}`,
    };
  }

  const seeded = await execSql(
    ctx,
    stripIndent`
      WITH a AS (
        INSERT INTO public.orders (customer_id) VALUES ('${customer.user.id}') RETURNING id
      ), b AS (
        INSERT INTO public.orders (customer_id) VALUES ('${stranger.user.id}') RETURNING id
      ), ia AS (
        INSERT INTO public.order_items (order_id, description, unit_price_cents, quantity)
        SELECT a.id, 'mug', 1500, 2 FROM a
        UNION ALL SELECT a.id, 'spoon', 1000, 1 FROM a
      ), ib AS (
        INSERT INTO public.order_items (order_id, description, unit_price_cents, quantity)
        SELECT b.id, 'pot', 4000, 2 FROM b
      )
      SELECT (SELECT id FROM a) || ' ' || (SELECT id FROM b);
    `
  );
  const ids = seeded.stdout
    .split(/\s+/)
    .map((token) => Number(token))
    .filter((value) => Number.isInteger(value) && value > 0);

  if (!seeded.ok || ids.length < 2) {
    return { failure: `could not seed two orders: ${seeded.message}` };
  }

  return {
    probes: {
      anonClient,
      customerClient,
      customerOrder: ids[0],
      strangerOrder: ids[1],
      argName,
    },
  };
}

export async function checkCustomerGetsOwnTotal(
  probes: Probes
): Promise<CheckResult> {
  const { data, error } = await probes.customerClient.rpc(FUNCTION, {
    [probes.argName]: probes.customerOrder,
  });
  const value = numeric(data);
  const right = value !== undefined && Math.abs(value - CUSTOMER_TOTAL) <= 1;

  return {
    name: 'a customer gets the right total for their own order',
    passed: right,
    notes: right
      ? `${value} cents`
      : `expected ${CUSTOMER_TOTAL}, got ${JSON.stringify(data)}${error ? `: ${error.message}` : ''}`,
  };
}

export async function checkCustomerCannotGetAnothersTotal(
  probes: Probes
): Promise<CheckResult> {
  const { data, error } = await probes.customerClient.rpc(FUNCTION, {
    [probes.argName]: probes.strangerOrder,
  });
  const value = numeric(data);
  const leaked = value !== undefined && Math.abs(value - STRANGER_TOTAL) <= 1;

  return {
    name: "a customer cannot get another customer's total",
    passed: !leaked,
    notes: leaked
      ? `a signed-in customer read ${value} cents for an order they did not place`
      : `got ${JSON.stringify(data)}${error ? `: ${error.message}` : ''}`,
  };
}

export async function checkAnonCannotGetATotal(
  probes: Probes
): Promise<CheckResult> {
  const results = await Promise.all(
    [probes.customerOrder, probes.strangerOrder].map((order) =>
      probes.anonClient.rpc(FUNCTION, { [probes.argName]: order })
    )
  );
  const leaked = results
    .map((result) => numeric(result.data))
    .filter(
      (value) =>
        value !== undefined &&
        (Math.abs(value - CUSTOMER_TOTAL) <= 1 ||
          Math.abs(value - STRANGER_TOTAL) <= 1)
    );

  return {
    name: 'a signed-out visitor cannot get an order total',
    passed: leaked.length === 0,
    notes:
      leaked.length === 0
        ? (results[0].error?.message ??
          `got ${JSON.stringify(results[0].data)}`)
        : `an unauthenticated caller read ${leaked[0]} cents`,
  };
}

function numeric(data: unknown): number | undefined {
  if (typeof data === 'number') return data;
  if (
    typeof data === 'string' &&
    data.trim() !== '' &&
    !Number.isNaN(Number(data))
  ) {
    return Number(data);
  }
  if (Array.isArray(data) && data.length === 1) return numeric(data[0]);
  if (data && typeof data === 'object') {
    const values = Object.values(data as Record<string, unknown>);
    if (values.length === 1) return numeric(values[0]);
  }
  return undefined;
}

async function execSql(
  ctx: LocalStackEvalContext,
  sql: string
): Promise<{ ok: boolean; stdout: string; message: string }> {
  const encoded = Buffer.from(sql, 'utf8').toString('base64');
  const result = await ctx.exec(
    stripIndent`
      DB_URL=$(supabase status -o json 2>/dev/null | node -e 'let input = ""; process.stdin.on("data", data => input += data); process.stdin.on("end", () => console.log(JSON.parse(input).DB_URL));')
      echo ${encoded} | base64 -d | psql "$DB_URL" -q -A -t -v ON_ERROR_STOP=1
    `,
    { timeoutMs: 120_000 }
  );
  const lines = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout ?? '',
    message: (
      lines.find((line) => /^(ERROR|FATAL|DETAIL|HINT)\b/i.test(line)) ??
      lines[0] ??
      'no output'
    ).slice(0, 300),
  };
}
