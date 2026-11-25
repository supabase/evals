import { randomUUID } from 'node:crypto';
import type { CheckResult } from '@supabase-evals/core';
import type { SqlResult } from '../lib/exec-sql.js';

export type Run = (sql: string) => Promise<SqlResult>;

const CHECK = {
  backOffice:
    'a status change from the back office is recorded on the timeline',
  customer:
    'a status change by a signed-in customer is recorded on the timeline',
  bulk: 'cancelling several orders at once records one entry per order',
  unchanged: 'saving an order without changing its status adds no entry',
  read: 'customers see the timeline of their own orders only',
  write: 'customers cannot add, change or remove timeline entries',
} as const;

type Entry = { orderId: number; oldStatus: string; newStatus: string };
type Order = { id: number; status: string; note: string };
type Outcome<T> = { ok: true; value: T } | { ok: false; message: string };

type Role = 'authenticated' | 'service_role';

const BACK_OFFICE_CLAIMS = { role: 'service_role' };

export async function checkBackOfficeChange(run: Run): Promise<CheckResult> {
  const placed = await placeOrders(run, randomUUID(), ['placed']);
  if (!placed.ok) return fail(CHECK.backOffice, placed.message);
  const [id] = placed.value;
  const updated = await run(
    asRole(
      'service_role',
      BACK_OFFICE_CLAIMS,
      `update public.orders set status = 'packed' where id = ${id};`
    )
  );
  if (!updated.ok) {
    return fail(
      CHECK.backOffice,
      `the back office update failed: ${updated.message}`
    );
  }
  return checkRecorded(run, CHECK.backOffice, id, 'placed', 'packed');
}

export async function checkCustomerChange(run: Run): Promise<CheckResult> {
  const customer = randomUUID();
  const placed = await placeOrders(run, customer, ['placed']);
  if (!placed.ok) return fail(CHECK.customer, placed.message);
  const [id] = placed.value;
  const updated = await run(
    asRole(
      'authenticated',
      customerClaims(customer),
      `update public.orders set status = 'cancelled' where id = ${id};`
    )
  );
  if (!updated.ok) {
    return fail(
      CHECK.customer,
      `the customer's update failed: ${updated.message}`
    );
  }
  return checkRecorded(run, CHECK.customer, id, 'placed', 'cancelled');
}

export async function checkBulkCancel(run: Run): Promise<CheckResult> {
  const customer = randomUUID();
  const placed = await placeOrders(run, customer, [
    'placed',
    'placed',
    'placed',
    'shipped',
  ]);
  if (!placed.ok) return fail(CHECK.bulk, placed.message);
  const ids = placed.value;
  const open = ids.slice(0, 3);
  const shipped = ids[3] as number;
  const updated = await run(
    asRole(
      'authenticated',
      customerClaims(customer),
      `update public.orders set status = 'cancelled' where status = 'placed';`
    )
  );
  if (!updated.ok) {
    return fail(
      CHECK.bulk,
      `the customer's cancel-all update failed: ${updated.message}`
    );
  }
  const orders = await readOrders(run, ids);
  const entries = await readEntries(run, ids);
  if (!orders.ok) return fail(CHECK.bulk, orders.message);
  if (!entries.ok) return fail(CHECK.bulk, entries.message);
  const problems = [
    ...open.flatMap((id) => {
      const status = orders.value.find((order) => order.id === id)?.status;
      if (status !== 'cancelled') {
        return [`order ${id} is ${status ?? 'missing'}, not cancelled`];
      }
      const count = matching(entries.value, id, 'placed', 'cancelled');
      return count === 1
        ? []
        : [`order ${id} has ${count} placed to cancelled entries`];
    }),
    ...entries.value
      .filter((entry) => entry.orderId === shipped)
      .filter((entry) => entry.newStatus === 'cancelled')
      .map(() => `the shipped order ${shipped} got a cancelled entry`),
  ];
  return {
    name: CHECK.bulk,
    passed: problems.length === 0,
    notes:
      problems.length === 0
        ? `three orders cancelled in one statement, one entry each: ${open.join(', ')}`
        : `${problems.join('; ')}. Entries: ${describe(entries.value)}`,
  };
}

export async function checkUnchangedStatus(run: Run): Promise<CheckResult> {
  const customer = randomUUID();
  const placed = await placeOrders(run, customer, ['placed']);
  if (!placed.ok) return fail(CHECK.unchanged, placed.message);
  const [id] = placed.value;
  const before = await readEntries(run, [id]);
  if (!before.ok) return fail(CHECK.unchanged, before.message);
  const note = `note-${randomUUID().slice(0, 8)}`;
  const updated = await run(
    asRole(
      'authenticated',
      customerClaims(customer),
      `update public.orders set status = 'placed', delivery_note = ${literal(note)} where id = ${id};`
    )
  );
  if (!updated.ok) {
    return fail(
      CHECK.unchanged,
      `saving the order form failed: ${updated.message}`
    );
  }
  const orders = await readOrders(run, [id]);
  const after = await readEntries(run, [id]);
  if (!orders.ok) return fail(CHECK.unchanged, orders.message);
  if (!after.ok) return fail(CHECK.unchanged, after.message);
  const saved = orders.value[0]?.note === note;
  const added = after.value.length - before.value.length;
  return {
    name: CHECK.unchanged,
    passed: saved && added === 0,
    notes: !saved
      ? `the delivery note did not save, so the edit did not go through: ${orders.value[0]?.note ?? 'order missing'}`
      : added === 0
        ? 'the note saved and the timeline is unchanged'
        : `the note saved and the timeline gained ${added} entr${added === 1 ? 'y' : 'ies'}: ${describe(after.value.slice(before.value.length))}`,
  };
}

export async function checkCustomersReadOwn(run: Run): Promise<CheckResult> {
  const customer = randomUUID();
  const placed = await placeOrders(run, customer, ['packed']);
  if (!placed.ok) return fail(CHECK.read, placed.message);
  const [id] = placed.value;
  const added = await addEntry(run, id);
  if (!added.ok) return fail(CHECK.read, added.message);
  const query = `select 'COUNT:' || count(*) from public.order_status_history where order_id = ${id};`;
  const own = await readCount(
    run,
    asRole('authenticated', customerClaims(customer), query)
  );
  const other = await readCount(
    run,
    asRole('authenticated', customerClaims(randomUUID()), query)
  );
  if (!own.ok)
    return fail(CHECK.read, `the owner's read failed: ${own.message}`);
  if (!other.ok) {
    return fail(CHECK.read, `another customer's read failed: ${other.message}`);
  }
  const passed = own.value > 0 && other.value === 0;
  return {
    name: CHECK.read,
    passed,
    notes: `the owner sees ${own.value} entr${own.value === 1 ? 'y' : 'ies'} for order ${id}, another customer sees ${other.value}`,
  };
}

export async function checkCustomersCannotWrite(
  run: Run
): Promise<CheckResult> {
  const customer = randomUUID();
  const placed = await placeOrders(run, customer, ['packed']);
  if (!placed.ok) return fail(CHECK.write, placed.message);
  const [id] = placed.value;
  const added = await addEntry(run, id);
  if (!added.ok) return fail(CHECK.write, added.message);
  const entry = added.value;
  const forgery = `insert into public.order_status_history (order_id, old_status, new_status) values (${id}, 'packed', 'delivered');`;
  const control = await run(`begin; ${forgery} rollback;`);
  if (!control.ok) {
    return fail(
      CHECK.write,
      `could not measure: the scorer's entry is refused even to the scorer's own connection: ${control.message}`
    );
  }
  const attempts = [
    forgery,
    `update public.order_status_history set new_status = 'delivered' where id = ${entry};`,
    `delete from public.order_status_history where id = ${entry};`,
  ]
    .map((statement) => swallow(statement))
    .join('\n');
  const tried = await run(
    asRole('authenticated', customerClaims(customer), attempts)
  );
  if (!tried.ok) {
    return fail(
      CHECK.write,
      `the customer's write attempts did not run: ${tried.message}`
    );
  }
  const entries = await readEntries(run, [id]);
  const rows = await run(
    `select 'KEPT:' || coalesce(new_status, '') from public.order_status_history where id = ${entry};`
  );
  if (!entries.ok) return fail(CHECK.write, entries.message);
  if (!rows.ok) return fail(CHECK.write, rows.message);
  const forged = matching(entries.value, id, 'packed', 'delivered');
  const kept = tagged(rows.stdout, 'KEPT')[0];
  const problems = [
    forged > 0 ? 'the customer added an entry' : undefined,
    kept === undefined ? 'the customer removed an entry' : undefined,
    kept !== undefined && kept !== 'packed'
      ? 'the customer changed an entry'
      : undefined,
  ].filter((problem): problem is string => problem !== undefined);
  return {
    name: CHECK.write,
    passed: problems.length === 0,
    notes:
      problems.length === 0
        ? 'insert, update and delete as the customer left the timeline as it was'
        : `${problems.join('; ')}. Entries: ${describe(entries.value)}`,
  };
}

async function checkRecorded(
  run: Run,
  name: string,
  id: number,
  from: string,
  to: string
): Promise<CheckResult> {
  const orders = await readOrders(run, [id]);
  const entries = await readEntries(run, [id]);
  if (!orders.ok) return fail(name, orders.message);
  if (!entries.ok) return fail(name, entries.message);
  const status = orders.value[0]?.status;
  if (status !== to) {
    return fail(
      name,
      `order ${id} is ${status ?? 'missing'} after the update, not ${to}, so the change did not land`
    );
  }
  const count = matching(entries.value, id, from, to);
  return {
    name,
    passed: count === 1,
    notes:
      count === 1
        ? `order ${id} has one ${from} to ${to} entry`
        : `order ${id} has ${count} ${from} to ${to} entries. Entries: ${describe(entries.value)}`,
  };
}

async function placeOrders(
  run: Run,
  customer: string,
  statuses: string[]
): Promise<Outcome<number[]>> {
  const values = statuses
    .map((status) => `(${literal(customer)}, ${literal(status)})`)
    .join(', ');
  const result = await run(
    `insert into public.orders (customer_id, status) values ${values} returning 'ID:' || id;`
  );
  if (!result.ok) {
    return {
      ok: false,
      message: `the scorer could not add orders: ${result.message}`,
    };
  }
  const ids = tagged(result.stdout, 'ID').map((id) => Number(id));
  return ids.length === statuses.length
    ? { ok: true, value: ids }
    : {
        ok: false,
        message: `the scorer added ${ids.length} of ${statuses.length} orders`,
      };
}

async function addEntry(run: Run, orderId: number): Promise<Outcome<number>> {
  const result = await run(
    `insert into public.order_status_history (order_id, old_status, new_status) values (${orderId}, 'placed', 'packed') returning 'ID:' || id;`
  );
  if (!result.ok) {
    return {
      ok: false,
      message: `the scorer could not add a timeline entry: ${result.message}`,
    };
  }
  const id = tagged(result.stdout, 'ID')[0];
  return id
    ? { ok: true, value: Number(id) }
    : { ok: false, message: 'the scorer added no timeline entry' };
}

async function readOrders(run: Run, ids: number[]): Promise<Outcome<Order[]>> {
  const result = await run(
    `select 'ORDER:' || id || '|' || status || '|' || coalesce(delivery_note, '') from public.orders where id in (${ids.join(', ')});`
  );
  if (!result.ok) {
    return {
      ok: false,
      message: `the scorer could not read orders: ${result.message}`,
    };
  }
  return {
    ok: true,
    value: tagged(result.stdout, 'ORDER').map((row) => {
      const [id, status, note] = row.split('|');
      return { id: Number(id), status: status ?? '', note: note ?? '' };
    }),
  };
}

async function readEntries(run: Run, ids: number[]): Promise<Outcome<Entry[]>> {
  const result = await run(
    `select 'ENTRY:' || order_id || '|' || coalesce(old_status, '') || '|' || coalesce(new_status, '') from public.order_status_history where order_id in (${ids.join(', ')}) order by id;`
  );
  if (!result.ok) {
    return {
      ok: false,
      message: `the scorer could not read the timeline: ${result.message}`,
    };
  }
  return {
    ok: true,
    value: tagged(result.stdout, 'ENTRY').map((row) => {
      const [orderId, oldStatus, newStatus] = row.split('|');
      return {
        orderId: Number(orderId),
        oldStatus: oldStatus ?? '',
        newStatus: newStatus ?? '',
      };
    }),
  };
}

async function readCount(run: Run, sql: string): Promise<Outcome<number>> {
  const result = await run(sql);
  if (!result.ok) return { ok: false, message: result.message };
  const count = tagged(result.stdout, 'COUNT')[0];
  return count
    ? { ok: true, value: Number(count) }
    : { ok: false, message: 'no count came back' };
}

function matching(
  entries: Entry[],
  orderId: number,
  from: string,
  to: string
): number {
  return entries.filter(
    (entry) =>
      entry.orderId === orderId &&
      entry.oldStatus === from &&
      entry.newStatus === to
  ).length;
}

function customerClaims(customer: string): Record<string, string> {
  return { sub: customer, role: 'authenticated' };
}

function asRole(
  role: Role,
  claims: Record<string, string>,
  sql: string
): string {
  return `
    begin;
    set local role ${role};
    set local "request.jwt.claims" = ${literal(JSON.stringify(claims))};
    ${sql}
    commit;
  `;
}

function swallow(statement: string): string {
  return `do $$ begin ${statement} exception when others then null; end $$;`;
}

function describe(entries: Entry[]): string {
  return entries.length === 0
    ? 'none'
    : entries
        .map(
          (entry) =>
            `${entry.orderId}: ${entry.oldStatus || 'null'} to ${entry.newStatus}`
        )
        .join(', ');
}

function fail(name: string, notes: string): CheckResult {
  return { name, passed: false, notes };
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function tagged(output: string, tag: string): string[] {
  const prefix = `${tag}:`;
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}
