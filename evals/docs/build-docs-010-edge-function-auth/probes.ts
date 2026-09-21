import { randomUUID } from 'node:crypto';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

import type { StackState } from './stack.js';

const PASSWORD = 'secret123';
const FUNCTION = 'order-history';

export type Probes = {
  stack: StackState;
  customerToken: string;
  strangerToken: string;
  customerId: string;
  strangerId: string;
  customerItem: string;
  strangerItem: string;
};

export type Setup = { probes: Probes } | { failure: string };

type Answer = { status: number; body: string; reached: boolean };

export async function setupProbes(
  ctx: LocalStackEvalContext,
  stack: StackState
): Promise<Setup> {
  const run = randomUUID().slice(0, 8);
  const customerItem = `thistle-teapot-${run}`;
  const strangerItem = `thistle-kettle-${run}`;

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
    !customer.session?.access_token ||
    !stranger.user?.id ||
    !stranger.session?.access_token
  ) {
    return {
      failure: `could not sign two customers up: ${customerError?.message ?? strangerError?.message ?? 'no session'}`,
    };
  }

  const seeded = await execSql(
    ctx,
    stripIndent`
      INSERT INTO public.orders (customer_id, item) VALUES
        ('${customer.user.id}', '${customerItem}'),
        ('${stranger.user.id}', '${strangerItem}');
    `
  );
  if (!seeded.ok) {
    return { failure: `could not seed orders: ${seeded.message}` };
  }

  return {
    probes: {
      stack,
      customerToken: customer.session.access_token,
      strangerToken: stranger.session.access_token,
      customerId: customer.user.id,
      strangerId: stranger.user.id,
      customerItem,
      strangerItem,
    },
  };
}

export async function checkEndpointIsServed(
  probes: Probes
): Promise<CheckResult> {
  const answer = await invoke(probes, {
    authorization: `Bearer ${probes.customerToken}`,
    apikey: probes.stack.publishableKey as string,
  });

  const served =
    answer.reached &&
    answer.status !== 404 &&
    answer.status !== 502 &&
    answer.status !== 503;
  const unreachableDependency =
    answer.status === 503 &&
    /name resolution|dns|fetch failed/i.test(answer.body);
  const workerNeverBooted = answer.status === 502;

  return {
    name: 'the order-history endpoint answers',
    passed: served,
    notes: !answer.reached
      ? `nothing served at /functions/v1/${FUNCTION}: ${answer.body}`
      : unreachableDependency
        ? `the worker could not reach the network to load its imports, so this run measured nothing about the handler: ${preview(answer.body)}`
        : workerNeverBooted
          ? `the gateway answered 502, so the worker never ran and this run measured nothing about the handler: ${preview(answer.body)}`
          : `status ${answer.status}: ${preview(answer.body)}`,
  };
}

export async function checkCustomerGetsOwnOrders(
  probes: Probes
): Promise<CheckResult> {
  const answer = await invoke(probes, {
    authorization: `Bearer ${probes.customerToken}`,
    apikey: probes.stack.publishableKey as string,
  });

  return {
    name: 'a signed-in customer gets their own orders back',
    passed:
      answer.status >= 200 &&
      answer.status < 300 &&
      answer.body.includes(probes.customerItem),
    notes: `status ${answer.status}: ${preview(answer.body)}`,
  };
}

export async function checkCustomerDoesNotGetOthers(
  probes: Probes
): Promise<CheckResult> {
  const answer = await invoke(probes, {
    authorization: `Bearer ${probes.customerToken}`,
    apikey: probes.stack.publishableKey as string,
  });

  return {
    name: "a signed-in customer does not get another customer's orders",
    passed: !answer.body.includes(probes.strangerItem),
    notes: answer.body.includes(probes.strangerItem)
      ? `the response carried ${probes.strangerItem}: ${preview(answer.body)}`
      : `status ${answer.status}: ${preview(answer.body)}`,
  };
}

export async function checkCustomerCannotAskForAnother(
  probes: Probes
): Promise<CheckResult> {
  const answer = await invoke(
    probes,
    {
      authorization: `Bearer ${probes.customerToken}`,
      apikey: probes.stack.publishableKey as string,
    },
    { customer_id: probes.strangerId, user_id: probes.strangerId }
  );

  return {
    name: "a customer asking for another customer's orders still gets only their own",
    passed: !answer.body.includes(probes.strangerItem),
    notes: answer.body.includes(probes.strangerItem)
      ? `naming another customer returned ${probes.strangerItem}: ${preview(answer.body)}`
      : `status ${answer.status}: ${preview(answer.body)}`,
  };
}

export async function checkSignedOutCallerGetsNothing(
  probes: Probes
): Promise<CheckResult> {
  const withKey = await invoke(probes, {
    apikey: probes.stack.publishableKey as string,
  });
  const bare = await invoke(probes, {});
  const leaked = [withKey, bare].filter(
    (answer) =>
      answer.body.includes(probes.customerItem) ||
      answer.body.includes(probes.strangerItem)
  );

  return {
    name: 'a caller with no session gets no orders',
    passed: leaked.length === 0,
    notes:
      leaked.length === 0
        ? `apikey only: ${withKey.status}, no headers: ${bare.status}`
        : `an unauthenticated call returned an order: ${preview(leaked[0].body)}`,
  };
}

async function invoke(
  probes: Probes,
  headers: Record<string, string>,
  body?: Record<string, unknown>
): Promise<Answer> {
  const posted = await send(probes, 'POST', headers, body);
  if (posted.status !== 405) return posted;
  return send(probes, 'GET', headers, body);
}

async function send(
  probes: Probes,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  body?: Record<string, unknown>
): Promise<Answer> {
  const url = new URL(`${probes.stack.apiUrl}/functions/v1/${FUNCTION}`);
  if (method === 'GET' && body) {
    for (const [key, value] of Object.entries(body)) {
      url.searchParams.set(key, String(value));
    }
  }

  try {
    const response = await fetch(url, {
      method,
      headers:
        method === 'POST'
          ? { 'content-type': 'application/json', ...headers }
          : headers,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
    return {
      status: response.status,
      body: await response.text(),
      reached: true,
    };
  } catch (error) {
    return {
      status: 0,
      body: error instanceof Error ? error.message : String(error),
      reached: false,
    };
  }
}

function preview(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat || '(empty)';
}

async function execSql(
  ctx: LocalStackEvalContext,
  sql: string
): Promise<{ ok: boolean; stdout: string; message: string }> {
  const encoded = Buffer.from(sql, 'utf8').toString('base64');
  const result = await ctx.exec(
    stripIndent`
      DB_URL=$(supabase status -o json 2>/dev/null | node -e 'let input = ""; process.stdin.on("data", data => input += data); process.stdin.on("end", () => console.log(JSON.parse(input).DB_URL));')
      echo ${encoded} | base64 -d | psql "$DB_URL" -q -v ON_ERROR_STOP=1
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
