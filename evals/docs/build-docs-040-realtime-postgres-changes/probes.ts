import { randomUUID } from 'node:crypto';
import type {
  CheckResult,
  LocalStackEvalContext,
  SupabaseClient,
} from '@supabase-evals/core';
import type { SqlResult } from '../lib/exec-sql.js';
import { messageOf } from '../lib/local-stack.js';

export const CHECK = {
  inserted: "a customer's order screen gets a new order as the shop creates it",
  updated: "a customer's order screen gets a status change on their order",
  previous: 'a status change carries the status the order had before',
  deleted: "a customer's order screen drops an order the shop deletes",
  others: "a customer gets no changes to another customer's orders",
  visitor: 'a visitor who is not signed in gets no order changes',
  banner: 'the open or closed banner still updates live',
} as const;

const PASSWORD = 'leafline-secret-123';
const READY_TIMEOUT_MS = 30_000;
const WARMUP_TIMEOUT_MS = 30_000;
const EVENT_TIMEOUT_MS = 20_000;
const QUIET_MS = 3_000;

export type Run = (sql: string) => Promise<SqlResult>;

type Row = Record<string, unknown>;

type Change = { eventType: string; new: Row; old: Row };

type SystemMessage = { status?: string; message?: string; extension?: string };

type Listener = {
  label: string;
  changes: Change[];
  system: SystemMessage[];
  statuses: string[];
};

export type Observation = {
  marker: string;
  ownerId: string;
  orderId: string;
  owner: Listener;
  other: Listener;
  visitorOrders: Listener;
  visitorBanner: Listener;
  warmup?: string;
};

export type Observed = { observation: Observation } | { failure: string };

export async function observe(
  ctx: LocalStackEvalContext,
  run: Run
): Promise<Observed> {
  const marker = `leaf-${randomUUID().slice(0, 8)}`;
  const clients: SupabaseClient[] = [];
  try {
    const owner = await signUp(ctx, `${marker}-owner@example.test`);
    if ('failure' in owner) return owner;
    const other = await signUp(ctx, `${marker}-other@example.test`);
    if ('failure' in other) return other;
    const visitor = await ctx.getClient();
    clients.push(owner.client, other.client, visitor);

    const listeners = {
      owner: listen(owner.client, `my-orders-${owner.id}`, 'orders', {
        filter: `customer_id=eq.${owner.id}`,
      }),
      other: listen(other.client, `${marker}-other`, 'orders'),
      visitorOrders: listen(visitor, `${marker}-visitor-orders`, 'orders'),
      visitorBanner: listen(visitor, `${marker}-visitor-banner`, 'shop_status'),
    };

    const ready = await Promise.all(
      Object.values(listeners).map((entry) => entry.ready)
    );
    const stuck = ready.filter((problem): problem is string => !!problem);
    if (stuck.length > 0) {
      return {
        failure: `the scorer could not listen for changes: ${stuck.join('; ')}`,
      };
    }

    const warmup = await warmUp(run, marker, listeners.visitorBanner.listener);
    const written = await writeChanges(run, marker, owner.id, other.id);
    if ('failure' in written) return written;

    const observation: Observation = {
      marker,
      ownerId: owner.id,
      orderId: written.orderId,
      owner: listeners.owner.listener,
      other: listeners.other.listener,
      visitorOrders: listeners.visitorOrders.listener,
      visitorBanner: listeners.visitorBanner.listener,
      warmup,
    };

    await waitForPositives(observation);
    await sleep(QUIET_MS);
    return { observation };
  } catch (error) {
    return { failure: messageOf(error) };
  } finally {
    await Promise.all(
      clients.map((client) => client.removeAllChannels().catch(() => []))
    );
  }
}

async function signUp(
  ctx: LocalStackEvalContext,
  email: string
): Promise<{ client: SupabaseClient; id: string } | { failure: string }> {
  const client = await ctx.getClient();
  const { data, error } = await client.auth.signUp({
    email,
    password: PASSWORD,
  });
  if (error || !data.user || !data.session) {
    return {
      failure: `a customer could not sign up: ${error?.message ?? 'no session'}`,
    };
  }
  return { client, id: data.user.id };
}

function listen(
  client: SupabaseClient,
  topic: string,
  table: string,
  options: { filter?: string } = {}
): { listener: Listener; ready: Promise<string | undefined> } {
  const listener: Listener = {
    label: `${table} as ${topic}`,
    changes: [],
    system: [],
    statuses: [],
  };
  const ready = new Promise<string | undefined>((resolve) => {
    const timer = setTimeout(() => {
      resolve(
        `${listener.label} did not connect within ${READY_TIMEOUT_MS / 1000}s (${listener.statuses.join(', ') || 'no status'})`
      );
    }, READY_TIMEOUT_MS);
    const settle = () => {
      if (
        listener.statuses.includes('SUBSCRIBED') &&
        answer(listener) !== undefined
      ) {
        clearTimeout(timer);
        resolve(undefined);
      }
    };
    client
      .channel(topic)
      .on('system', {}, (payload: SystemMessage) => {
        listener.system.push(payload);
        settle();
      })
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table, ...options },
        (payload: Change) => {
          listener.changes.push({
            eventType: payload.eventType,
            new: payload.new ?? {},
            old: payload.old ?? {},
          });
        }
      )
      .subscribe((status: string, error?: Error) => {
        listener.statuses.push(error ? `${status} ${error.message}` : status);
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          clearTimeout(timer);
          resolve(`${listener.label}: ${status} ${error?.message ?? ''}`);
          return;
        }
        settle();
      });
  });
  return { listener, ready };
}

function answer(listener: Listener): SystemMessage | undefined {
  return listener.system.find(
    (message) => message.extension === 'postgres_changes'
  );
}

function accepted(listener: Listener): boolean {
  return answer(listener)?.status === 'ok';
}

async function warmUp(
  run: Run,
  marker: string,
  banner: Listener
): Promise<string | undefined> {
  const message = `${marker} warming up`;
  const result = await run(
    `update public.shop_status set message = ${literal(message)} where id = 1;`
  );
  if (!result.ok) {
    return `the scorer could not change the banner before the orders: ${result.message}`;
  }
  const deadline = Date.now() + WARMUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (
      banner.changes.some(
        (change) =>
          change.eventType === 'UPDATE' && change.new.message === message
      )
    ) {
      return undefined;
    }
    await sleep(250);
  }
  return `the banner change sent before the orders never arrived within ${WARMUP_TIMEOUT_MS / 1000}s, so the stack may not have been delivering changes yet${systemNote(banner)}`;
}

async function writeChanges(
  run: Run,
  marker: string,
  ownerId: string,
  otherId: string
): Promise<{ orderId: string } | { failure: string }> {
  const inserted = await run(
    `insert into public.orders (customer_id, item, status) values (${literal(ownerId)}, ${literal(`${marker} fern`)}, 'packed') returning id;`
  );
  const orderId = inserted.stdout.trim().split('\n')[0]?.trim() ?? '';
  if (!inserted.ok || !/^\d+$/.test(orderId)) {
    return { failure: `could not add an order: ${inserted.message}` };
  }
  const steps = [
    `insert into public.orders (customer_id, item, status) values (${literal(otherId)}, ${literal(`${marker} cactus`)}, 'placed');`,
    `update public.orders set status = 'shipped', updated_at = now() where id = ${orderId};`,
    `update public.shop_status set message = ${literal(`${marker} closing early`)} where id = 1;`,
    `delete from public.orders where id = ${orderId};`,
  ];
  for (const step of steps) {
    await sleep(300);
    const result = await run(step);
    if (!result.ok) {
      return { failure: `could not change the data: ${result.message}` };
    }
  }
  return { orderId };
}

async function waitForPositives(observation: Observation): Promise<void> {
  const deadline = Date.now() + EVENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const arrived =
      ownerInsert(observation) &&
      ownerUpdate(observation) &&
      ownerDelete(observation) &&
      otherOwnInsert(observation) &&
      bannerUpdate(observation);
    if (arrived) return;
    await sleep(250);
  }
}

function ownerInsert(observation: Observation): Change | undefined {
  return observation.owner.changes.find(
    (change) =>
      change.eventType === 'INSERT' &&
      change.new.item === `${observation.marker} fern`
  );
}

function ownerUpdate(observation: Observation): Change | undefined {
  return observation.owner.changes.find(
    (change) =>
      change.eventType === 'UPDATE' &&
      String(change.new.id) === observation.orderId &&
      change.new.status === 'shipped'
  );
}

function ownerDelete(observation: Observation): Change | undefined {
  return observation.owner.changes.find(
    (change) =>
      change.eventType === 'DELETE' &&
      String(change.old.id) === observation.orderId
  );
}

function otherOwnInsert(observation: Observation): Change | undefined {
  return observation.other.changes.find(
    (change) =>
      change.eventType === 'INSERT' &&
      change.new.item === `${observation.marker} cactus`
  );
}

function bannerUpdate(observation: Observation): Change | undefined {
  return observation.visitorBanner.changes.find(
    (change) =>
      change.eventType === 'UPDATE' &&
      change.new.message === `${observation.marker} closing early`
  );
}

function ownerOrderLeaks(
  observation: Observation,
  listener: Listener
): Change[] {
  return listener.changes.filter(
    (change) =>
      change.eventType !== 'DELETE' &&
      (change.new.customer_id === observation.ownerId ||
        String(change.new.item ?? '').startsWith(`${observation.marker} fern`))
  );
}

export function checkInserted(observation: Observation): CheckResult {
  return arrival(
    CHECK.inserted,
    observation,
    ownerInsert(observation),
    'the new order arrived on the screen'
  );
}

export function checkUpdated(observation: Observation): CheckResult {
  return arrival(
    CHECK.updated,
    observation,
    ownerUpdate(observation),
    'the change to shipped arrived on the screen'
  );
}

export function checkPrevious(observation: Observation): CheckResult {
  const change = ownerUpdate(observation);
  if (!change) {
    return {
      name: CHECK.previous,
      passed: false,
      notes: `no status change arrived, so there was no earlier status to read${systemNote(observation.owner)}${warmupNote(observation)}`,
    };
  }
  const before = change.old.status;
  return {
    name: CHECK.previous,
    passed: before === 'packed',
    notes:
      before === 'packed'
        ? 'the change says it was packed before'
        : `the change carries no earlier status: old is ${JSON.stringify(change.old)}`,
  };
}

export function checkDeleted(observation: Observation): CheckResult {
  return arrival(
    CHECK.deleted,
    observation,
    ownerDelete(observation),
    'the deletion arrived on the screen'
  );
}

export function checkOthers(observation: Observation): CheckResult {
  const leaks = ownerOrderLeaks(observation, observation.other);
  if (leaks.length > 0) {
    return {
      name: CHECK.others,
      passed: false,
      notes: `another customer listening to every order got ${describe(leaks)}`,
    };
  }
  if (!otherOwnInsert(observation)) {
    return {
      name: CHECK.others,
      passed: false,
      notes: `could not measure: the other customer did not get a change to their own order either${systemNote(observation.other)}${warmupNote(observation)}`,
    };
  }
  return {
    name: CHECK.others,
    passed: true,
    notes:
      "another customer listening to every order got their own order and nothing of the first customer's",
  };
}

export function checkVisitor(observation: Observation): CheckResult {
  const leaks = observation.visitorOrders.changes.filter(
    (change) => change.eventType !== 'DELETE'
  );
  if (leaks.length > 0) {
    return {
      name: CHECK.visitor,
      passed: false,
      notes: `a visitor listening to every order got ${describe(leaks)}`,
    };
  }
  if (!accepted(observation.visitorOrders)) {
    return {
      name: CHECK.visitor,
      passed: false,
      notes: `could not measure: the server refused the visitor's subscription to orders, so nothing could reach it${systemNote(observation.visitorOrders)}`,
    };
  }
  if (!bannerUpdate(observation)) {
    return {
      name: CHECK.visitor,
      passed: false,
      notes: `could not measure: the same visitor did not get the banner change either${systemNote(observation.visitorBanner)}${warmupNote(observation)}`,
    };
  }
  if (!ownerInsert(observation)) {
    return {
      name: CHECK.visitor,
      passed: false,
      notes: `could not measure: order changes reached nobody, not even the customer who owns the order${systemNote(observation.owner)}${warmupNote(observation)}`,
    };
  }
  return {
    name: CHECK.visitor,
    passed: true,
    notes:
      'the server accepted the visitor on orders, and the visitor got the banner change on the same connection and no order changes, while the owner got theirs',
  };
}

export function checkBanner(observation: Observation): CheckResult {
  const change = bannerUpdate(observation);
  return {
    name: CHECK.banner,
    passed: change !== undefined,
    notes: change
      ? 'a visitor got the banner change'
      : `a visitor did not get the banner change within ${EVENT_TIMEOUT_MS / 1000}s${systemNote(observation.visitorBanner)}`,
  };
}

function arrival(
  name: string,
  observation: Observation,
  change: Change | undefined,
  passNote: string
): CheckResult {
  return {
    name,
    passed: change !== undefined,
    notes: change
      ? passNote
      : `nothing arrived within ${EVENT_TIMEOUT_MS / 1000}s; the screen got ${describe(observation.owner.changes)}${systemNote(observation.owner)}${warmupNote(observation)}`,
  };
}

function warmupNote(observation: Observation): string {
  return observation.warmup ? `; could not measure: ${observation.warmup}` : '';
}

function systemNote(listener: Listener): string {
  const problems = listener.system.filter(
    (message) => message.status && message.status !== 'ok'
  );
  return problems.length > 0
    ? `; the server said: ${problems.map((message) => message.message).join('; ')}`.slice(
        0,
        400
      )
    : '';
}

function describe(changes: Change[]): string {
  if (changes.length === 0) return 'no changes';
  return changes
    .map(
      (change) =>
        `${change.eventType} ${JSON.stringify(change.eventType === 'DELETE' ? change.old : change.new)}`
    )
    .join(', ')
    .slice(0, 400);
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(() => resolve(), ms));
}
