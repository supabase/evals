import { randomInt, randomUUID } from 'node:crypto';
import type {
  CheckResult,
  LocalStackEvalContext,
  SupabaseClient,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';
import { CREDIT_BALANCE, ORDER_TOTAL } from './catalog.js';

const PASSWORD = 'secret123';
const LEDGER = 'store_credit_ledger';
const CUSTOMER_TOTAL = 4330;
const STRANGER_TOTAL = 8660;

// What one function is probed with: the argument name the agent chose, the
// argument and expected figure for the customer's own record, and the same for
// the stranger's.
export type Target = {
  fn: string;
  argName: string;
  customerArg: unknown;
  customerValue: number;
  strangerArg: unknown;
  strangerValue: number;
  clients: Clients;
  // How a leak reads in a note: "a signed-in customer read 8660 <leak>".
  leak: string;
};

export type Blocked = { blocked: string };

type Clients = { anonClient: SupabaseClient; customerClient: SupabaseClient };

export type World = {
  clients: Clients;
  customerId: string;
  strangerId: string;
  orders: { customer: number; stranger: number } | { failure: string };
  credit: { customer: number; stranger: number } | { failure: string };
};

export type Setup = { world: World } | { failure: string };

// Signs up two customers and seeds both functions' data. Orders and the ledger
// are seeded in separate steps so a failure in one costs only the checks that
// needed it.
export async function setupWorld(ctx: LocalStackEvalContext): Promise<Setup> {
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

  return {
    world: {
      clients: { anonClient, customerClient },
      customerId: customer.user.id,
      strangerId: stranger.user.id,
      orders: await seedOrders(ctx, customer.user.id, stranger.user.id),
      credit: await seedLedger(ctx, customer.user.id, stranger.user.id),
    },
  };
}

async function seedOrders(
  ctx: LocalStackEvalContext,
  customerId: string,
  strangerId: string
): Promise<World['orders']> {
  const seeded = await execSql(
    ctx,
    stripIndent`
      WITH a AS (
        INSERT INTO public.orders (customer_id) VALUES ('${customerId}') RETURNING id
      ), b AS (
        INSERT INTO public.orders (customer_id) VALUES ('${strangerId}') RETURNING id
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
  return { customer: ids[0], stranger: ids[1] };
}

// Amounts are drawn per run, after the agent's code was written, so a literal
// in the function cannot satisfy the positive control. The two ranges cannot
// produce balances within a cent of each other.
async function seedLedger(
  ctx: LocalStackEvalContext,
  customerId: string,
  strangerId: string
): Promise<World['credit']> {
  const customer = [
    randomInt(4000, 6000),
    randomInt(500, 1500),
    -randomInt(100, 400),
  ];
  const stranger = [
    randomInt(8000, 12000),
    randomInt(500, 1500),
    -randomInt(100, 400),
  ];
  const reasons = ['refund', 'goodwill', 'purchase'];
  const values = (id: string, amounts: number[]) =>
    amounts
      .map((amount, i) => `('${id}', ${amount}, '${reasons[i]}')`)
      .join(', ');

  const seeded = await execSql(
    ctx,
    `INSERT INTO public.${LEDGER} (customer_id, amount_cents, reason) VALUES ${values(customerId, customer)}, ${values(strangerId, stranger)};`
  );
  if (!seeded.ok) {
    return { failure: `could not seed the ledger: ${seeded.message}` };
  }
  const sum = (amounts: number[]) => amounts.reduce((a, b) => a + b, 0);
  return { customer: sum(customer), stranger: sum(stranger) };
}

export function orderTarget(
  world: World,
  argName: string | undefined
): Target | Blocked {
  if (!argName) {
    return {
      blocked: `no single named argument on ${ORDER_TOTAL} to pass an order id to`,
    };
  }
  if ('failure' in world.orders) return { blocked: world.orders.failure };
  return {
    fn: ORDER_TOTAL,
    argName,
    customerArg: world.orders.customer,
    customerValue: CUSTOMER_TOTAL,
    strangerArg: world.orders.stranger,
    strangerValue: STRANGER_TOTAL,
    clients: world.clients,
    leak: 'cents for an order they did not place',
  };
}

export function creditTarget(
  world: World,
  argName: string | undefined
): Target | Blocked {
  if (!argName) {
    return {
      blocked: `no single named argument on ${CREDIT_BALANCE} to pass a customer id to`,
    };
  }
  if ('failure' in world.credit) return { blocked: world.credit.failure };
  return {
    fn: CREDIT_BALANCE,
    argName,
    customerArg: world.customerId,
    customerValue: world.credit.customer,
    strangerArg: world.strangerId,
    strangerValue: world.credit.stranger,
    clients: world.clients,
    leak: 'cents of store credit that was not theirs',
  };
}

// A blocked target fails the checks that needed it. It never skips them.
export async function gated(
  target: Target | Blocked,
  name: string,
  probe: (target: Target) => Promise<CheckResult>
): Promise<CheckResult> {
  if ('blocked' in target) {
    return { name, passed: false, notes: `not run: ${target.blocked}` };
  }
  return probe(target);
}

export async function checkCustomerGetsOwnFigure(
  target: Target,
  name: string
): Promise<CheckResult> {
  const { data, error } = await target.clients.customerClient.rpc(target.fn, {
    [target.argName]: target.customerArg,
  });
  const value = numeric(data);
  const right =
    value !== undefined && Math.abs(value - target.customerValue) <= 1;

  return {
    name,
    passed: right,
    notes: right
      ? `${value} cents`
      : `expected ${target.customerValue}, got ${JSON.stringify(data)}${error ? `: ${error.message}` : ''}`,
  };
}

export async function checkCustomerCannotGetAnothers(
  target: Target,
  name: string
): Promise<CheckResult> {
  const { data, error } = await target.clients.customerClient.rpc(target.fn, {
    [target.argName]: target.strangerArg,
  });
  const value = numeric(data);
  const leaked =
    value !== undefined && Math.abs(value - target.strangerValue) <= 1;

  return {
    name,
    passed: !leaked,
    notes: leaked
      ? `a signed-in customer read ${value} ${target.leak}`
      : `got ${JSON.stringify(data)}${error ? `: ${error.message}` : ''}`,
  };
}

export async function checkAnonCannotGet(
  target: Target,
  name: string
): Promise<CheckResult> {
  const results = await Promise.all(
    [target.customerArg, target.strangerArg].map((arg) =>
      target.clients.anonClient.rpc(target.fn, { [target.argName]: arg })
    )
  );
  const leaked = results
    .map((result) => numeric(result.data))
    .filter(
      (value) =>
        value !== undefined &&
        (Math.abs(value - target.customerValue) <= 1 ||
          Math.abs(value - target.strangerValue) <= 1)
    );

  return {
    name,
    passed: leaked.length === 0,
    notes:
      leaked.length === 0
        ? (results[0].error?.message ??
          `got ${JSON.stringify(results[0].data)}`)
        : `an unauthenticated caller read ${leaked[0]} cents`,
  };
}

// Reads the ledger the way an app would. It passes for an agent that built
// nothing, so it only means something beside the own-balance check: a customer
// can only get their balance from a ledger they cannot read through the
// function. Both ledgers hold seeded rows by now, so an empty answer is the
// table refusing, not the table being empty.
export async function checkLedgerStaysClosed(
  world: World
): Promise<CheckResult> {
  const name =
    'a customer or signed-out visitor cannot read the store credit ledger directly';
  if ('failure' in world.credit) {
    return { name, passed: false, notes: `not run: ${world.credit.failure}` };
  }

  const [customer, anon] = await Promise.all(
    [world.clients.customerClient, world.clients.anonClient].map((client) =>
      client.from(LEDGER).select('amount_cents')
    )
  );
  const customerRows = customer.data?.length ?? 0;
  const anonRows = anon.data?.length ?? 0;

  return {
    name,
    passed: customerRows === 0 && anonRows === 0,
    notes:
      customerRows === 0 && anonRows === 0
        ? (customer.error?.message ?? 'no rows came back')
        : `${customerRows > 0 ? `a signed-in customer read ${customerRows} ledger rows` : `an unauthenticated caller read ${anonRows} ledger rows`}`,
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
