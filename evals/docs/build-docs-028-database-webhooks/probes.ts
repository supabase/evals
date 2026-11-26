import { randomUUID } from 'node:crypto';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { execSql } from '../lib/exec-sql.js';

// The port the seed's service listens on. The scorer listens here itself after
// the agent is done, so what the checks read is what the database sent.
const PORT = 4100;

export const CHECK = {
  delivered: 'an order added to the table is sent to the service on port 4100',
  shape:
    'the call for a new order carries the order the way the service reads it',
  changed: 'a status change is sent with the order as it was and as it is now',
  others: 'a change to the customers table sends nothing to the service',
} as const;

type Call = { method: string; url: string; raw: string; body: unknown };

export type Probe =
  | { ok: false; why: string }
  | {
      ok: true;
      item: string;
      customer: string;
      orderId?: number;
      insertError?: string;
      updateError?: string;
      customerError?: string;
      calls: Call[];
    };

// Records every call that is not a readiness probe, one JSON line each. It
// answers 200 so the sender sees a healthy service.
const RECORDER = `
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const { PORT, OUT, LOG } = process.env;
createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    appendFileSync(OUT, JSON.stringify({ method: req.method, url: req.url, raw }) + '\\n');
    res.writeHead(200).end('ok');
  });
})
  .on('error', (error) => appendFileSync(LOG, 'error ' + error.message + '\\n'))
  .listen(Number(PORT), '0.0.0.0', () => appendFileSync(LOG, 'listening\\n'));
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs once. The scorer listens, adds an order, changes its status, adds a
// customer, and reads what arrived. Every value carries the run's marker, so a
// call the agent's own testing left behind cannot satisfy a check.
export async function probeService(ctx: LocalStackEvalContext): Promise<Probe> {
  const run = randomUUID().slice(0, 8);
  const out = `/tmp/webhook-calls-${run}.jsonl`;
  const log = `/tmp/webhook-recorder-${run}.log`;
  const script = `/tmp/webhook-recorder-${run}.mjs`;
  const item = `item-${run}`;
  const customer = `customer-${run}`;

  const started = await startRecorder(ctx, { run, out, log, script });
  if (started) return { ok: false, why: started };

  try {
    const probe: Probe = { ok: true, item, customer, calls: [] };

    const added = await execSql(
      ctx,
      `insert into public.orders (customer, item) values ('Probe', '${item}') returning id;`,
      { tuplesOnly: true }
    );
    if (added.ok) {
      probe.orderId = Number(
        added.stdout.split('\n').find((line) => /^\d+$/.test(line.trim()))
      );
    } else {
      probe.insertError = added.message;
    }
    await waitFor(ctx, out, (calls) => mentions(calls, item), 15_000);

    if (probe.orderId) {
      const changed = await execSql(
        ctx,
        `update public.orders set status = 'shipped' where id = ${probe.orderId};`
      );
      if (!changed.ok) probe.updateError = changed.message;
      await waitFor(
        ctx,
        out,
        (calls) => calls.some((call) => typeOf(call) === 'UPDATE'),
        15_000
      );
    }

    const customerAdded = await execSql(
      ctx,
      `insert into public.customers (name, email) values ('${customer}', '${customer}@example.com');`
    );
    if (!customerAdded.ok) probe.customerError = customerAdded.message;
    // Silence has no event to wait for, so this is a fixed window.
    await sleep(6_000);

    probe.calls = await readCalls(ctx, out);
    return probe;
  } finally {
    await ctx.exec(`pkill -f '[w]ebhook-recorder-${run}.mjs' || true`);
  }
}

async function startRecorder(
  ctx: LocalStackEvalContext,
  paths: { run: string; out: string; log: string; script: string }
): Promise<string | undefined> {
  const encoded = Buffer.from(RECORDER, 'utf8').toString('base64');
  // The seed's own service may still be running on the port. The bracket keeps
  // pkill from matching this command's own shell.
  const result = await ctx.exec(
    [
      `pkill -f '[r]eceiver.mjs' || true`,
      `echo ${encoded} | base64 -d > ${paths.script}`,
      `(PORT=${PORT} OUT=${paths.out} LOG=${paths.log} nohup node ${paths.script} >/dev/null 2>&1 &)`,
      `for i in $(seq 1 20); do grep -q . ${paths.log} 2>/dev/null && break; sleep 0.5; done`,
      `cat ${paths.log} 2>/dev/null`,
    ].join('\n'),
    { timeoutMs: 60_000 }
  );
  const said = (result.stdout ?? '').trim();
  return said === 'listening'
    ? undefined
    : `the scorer could not listen on port ${PORT}: ${said || 'no answer'}`;
}

async function readCalls(
  ctx: LocalStackEvalContext,
  out: string
): Promise<Call[]> {
  const result = await ctx.exec(`cat ${out} 2>/dev/null || true`);
  return (result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const call = JSON.parse(line) as Omit<Call, 'body'>;
        let body: unknown;
        try {
          body = JSON.parse(call.raw);
        } catch {
          body = undefined;
        }
        return [{ ...call, body }];
      } catch {
        return [];
      }
    });
}

async function waitFor(
  ctx: LocalStackEvalContext,
  out: string,
  done: (calls: Call[]) => boolean,
  ms: number
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (done(await readCalls(ctx, out))) return;
    await sleep(1_000);
  }
}

const mentions = (calls: Call[], text: string) =>
  calls.some((call) => call.raw.includes(text));

function typeOf(call: Call): unknown {
  return (call.body as { type?: unknown } | undefined)?.type;
}

type Order = { id?: unknown; item?: unknown; status?: unknown };
type Body = {
  type?: unknown;
  table?: unknown;
  schema?: unknown;
  record?: Order | null;
  old_record?: Order | null;
};

const bodyOf = (call: Call) => (call.body ?? {}) as Body;

function notRun(name: string, why: string): CheckResult {
  return { name, passed: false, notes: `not run: ${why}` };
}

const snippet = (calls: Call[], text: string) => {
  const call = calls.find((c) => c.raw.includes(text));
  return call
    ? `${call.method} ${call.url} with ${call.raw.slice(0, 160)}`
    : 'nothing';
};

// The positive control for the rest. It needs the database to send the call and
// the service to be reachable from inside the database's container.
export function checkDelivered(probe: Probe): CheckResult {
  const name = CHECK.delivered;
  if (!probe.ok) return notRun(name, probe.why);
  if (probe.insertError) {
    return {
      name,
      passed: false,
      notes: `adding an order failed: ${probe.insertError}`,
    };
  }
  const arrived = mentions(probe.calls, probe.item);
  return {
    name,
    passed: arrived,
    notes: arrived
      ? 'the service got a call about the new order'
      : 'no call about the new order reached the service in 15 seconds',
  };
}

export function checkShape(probe: Probe): CheckResult {
  const name = CHECK.shape;
  if (!probe.ok) return notRun(name, probe.why);
  if (probe.insertError) return notRun(name, 'adding an order failed');
  const call = probe.calls.find((c) => c.raw.includes(probe.item));
  if (!call) return notRun(name, 'no call arrived to read');
  const body = bodyOf(call);
  const record = body.record ?? {};
  const right =
    call.method === 'POST' &&
    body.type === 'INSERT' &&
    body.table === 'orders' &&
    body.schema === 'public' &&
    Number(record.id) === probe.orderId &&
    record.item === probe.item &&
    record.status === 'placed' &&
    body.old_record === null;
  return {
    name,
    passed: right,
    notes: right
      ? 'a POST with type, table, schema, record and a null old_record'
      : `the service got ${snippet(probe.calls, probe.item)}`,
  };
}

export function checkChanged(probe: Probe): CheckResult {
  const name = CHECK.changed;
  if (!probe.ok) return notRun(name, probe.why);
  if (!probe.orderId) return notRun(name, 'there was no order to change');
  if (probe.updateError) {
    return {
      name,
      passed: false,
      notes: `changing the order failed: ${probe.updateError}`,
    };
  }
  const call = probe.calls.find((c) => {
    const body = bodyOf(c);
    return body.type === 'UPDATE' && Number(body.record?.id) === probe.orderId;
  });
  if (!call) {
    const odd = probe.calls.find((c) => c.raw.includes('"shipped"'));
    return {
      name,
      passed: false,
      notes: odd
        ? `a call arrived but without an UPDATE type: ${odd.raw.slice(0, 160)}`
        : 'no call about the status change reached the service in 15 seconds',
    };
  }
  const body = bodyOf(call);
  const right =
    call.method === 'POST' &&
    body.table === 'orders' &&
    body.record?.status === 'shipped' &&
    body.old_record?.status === 'placed';
  return {
    name,
    passed: right,
    notes: right
      ? 'record is shipped and old_record is placed'
      : `the service got ${call.raw.slice(0, 200)}`,
  };
}

// Absence is only evidence once the service is known to hear calls at all.
export function checkOthers(probe: Probe): CheckResult {
  const name = CHECK.others;
  if (!probe.ok) return notRun(name, probe.why);
  if (!mentions(probe.calls, probe.item)) {
    return notRun(
      name,
      'nothing reached the service for orders, so silence about customers proves nothing'
    );
  }
  if (probe.customerError) {
    return {
      name,
      passed: false,
      notes: `could not measure: adding a customer failed: ${probe.customerError}`,
    };
  }
  const leaked = probe.calls.find(
    (call) =>
      call.raw.includes(probe.customer) ||
      (bodyOf(call).table as unknown) === 'customers'
  );
  return {
    name,
    passed: !leaked,
    notes: leaked
      ? `the service got ${leaked.raw.slice(0, 160)}`
      : 'a customer was added and the service heard nothing about it',
  };
}
