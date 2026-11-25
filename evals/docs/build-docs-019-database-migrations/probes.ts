import { randomUUID } from 'node:crypto';
import type { CheckResult } from '@supabase-evals/core';
import type { MigrationFile } from './migrations.js';

// Plain functions so the probes also run on PGlite. Query reads the agent's
// local database. Run executes against whichever database it was bound to,
// returns psql's `-A -t` rows (`a|b`, one per line), and never throws.
export type Query = (
  sql: string
) => Promise<{ rows: Record<string, unknown>[] }>;
export type Run = (
  sql: string
) => Promise<{ ok: boolean; stdout: string; message: string }>;

export const CHECK = {
  local: "the agent's local database has the delivery option",
  rollout:
    'the new migrations apply on top of a database that already has orders',
  existing: 'orders that already existed come out as standard',
  placing: 'a new order can be placed as standard or express',
  never: 'an order saved without a delivery option never has none',
  rebuild:
    'a database rebuilt from the migration files has the delivery option',
} as const;

// Every customer name starts with a per-run marker.
export type Marker = string;
export const newMarker = (): Marker => `kc${randomUUID().slice(0, 8)}`;

const HAS_COLUMN = `
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name = 'delivery_option'
  ) as present`;

/** Read before the scorer touches the database, so it reports the agent's own state. */
export async function checkLocalDatabase(query: Query): Promise<CheckResult> {
  const { rows } = await query(HAS_COLUMN);
  const present = rows[0]?.present === true;
  return {
    name: CHECK.local,
    passed: present,
    notes: present
      ? 'public.orders.delivery_option exists'
      : 'public.orders has no delivery_option column',
  };
}

export type Rollout = { ok: true } | { ok: false; reason: string };

/**
 * What production looks like before the release: only the migrations the repo
 * started with, and orders in the table. Then the agent's new migrations, in
 * the order the CLI runs them. Built from the seed's own files so an edit to
 * one of them can't leak into the starting point.
 */
export async function rollOut(
  run: Run,
  marker: Marker,
  shipped: MigrationFile[],
  added: MigrationFile[]
): Promise<Rollout> {
  for (const file of shipped) {
    const applied = await run(file.sql);
    if (!applied.ok) {
      return {
        ok: false,
        reason: `scorer setup: ${file.name}: ${applied.message}`,
      };
    }
  }
  const orders = await run(
    `insert into public.orders (customer, total_cents) values
       ('${marker}-a', 1200), ('${marker}-b', 450), ('${marker}-c', 8900);`
  );
  if (!orders.ok) {
    return {
      ok: false,
      reason: `scorer setup: could not add orders: ${orders.message}`,
    };
  }
  if (added.length === 0) {
    return { ok: false, reason: 'no new migration file to apply' };
  }
  for (const file of added) {
    const applied = await run(file.sql);
    if (!applied.ok) {
      return { ok: false, reason: `${file.name}: ${applied.message}` };
    }
  }
  return { ok: true };
}

export function checkRollout(rollout: Rollout): CheckResult {
  return {
    name: CHECK.rollout,
    passed: rollout.ok,
    notes: rollout.ok
      ? 'every new migration applied to a database holding three orders'
      : rollout.reason,
  };
}

function blocked(name: string, rollout: Rollout): CheckResult | undefined {
  return rollout.ok
    ? undefined
    : { name, passed: false, notes: `not run: ${rollout.reason}` };
}

export async function checkExistingOrders(
  run: Run,
  marker: Marker,
  rollout: Rollout
): Promise<CheckResult> {
  const name = CHECK.existing;
  const skipped = blocked(name, rollout);
  if (skipped) return skipped;
  const read = await run(
    `select coalesce(delivery_option::text, '<none>'), count(*)
     from public.orders where customer like '${marker}-%' group by 1 order by 1;`
  );
  if (!read.ok) return { name, passed: false, notes: read.message };
  const rows = read.stdout.trim();
  // Three orders went in and all three must read standard. An empty read
  // proves nothing, so it fails.
  return {
    name,
    passed: rows === 'standard|3',
    notes:
      rows === 'standard|3'
        ? 'all three read standard'
        : `delivery_option | orders: ${rows.replaceAll('\n', ', ') || 'no rows'}`,
  };
}

export async function checkPlacingOrders(
  run: Run,
  marker: Marker,
  rollout: Rollout
): Promise<CheckResult> {
  const name = CHECK.placing;
  const skipped = blocked(name, rollout);
  if (skipped) return skipped;
  const placed = await run(
    `insert into public.orders (customer, total_cents, delivery_option) values
       ('${marker}-std', 700, 'standard'), ('${marker}-exp', 700, 'express');`
  );
  if (!placed.ok) return { name, passed: false, notes: placed.message };
  const read = await run(
    `select customer, delivery_option from public.orders
     where customer in ('${marker}-std', '${marker}-exp') order by customer;`
  );
  const expected = `${marker}-exp|express\n${marker}-std|standard`;
  return {
    name,
    passed: read.ok && read.stdout.trim() === expected,
    notes: read.ok
      ? `read back: ${read.stdout.trim().replaceAll('\n', ', ')}`
      : read.message,
  };
}

export async function checkNeverNone(
  run: Run,
  marker: Marker,
  rollout: Rollout
): Promise<CheckResult> {
  const name = CHECK.never;
  const skipped = blocked(name, rollout);
  if (skipped) return skipped;
  const saved = await run(
    `insert into public.orders (customer, total_cents) values ('${marker}-bare', 300);`
  );
  if (!saved.ok) {
    // Refusing is a fair way to require the option, but only when the column
    // is what refused. Any other error is the probe's own, not a pass.
    return /delivery_option/.test(saved.message)
      ? { name, passed: true, notes: `refused: ${saved.message}` }
      : {
          name,
          passed: false,
          notes: `could not save the order: ${saved.message}`,
        };
  }
  const read = await run(
    `select coalesce(delivery_option::text, '<none>') from public.orders where customer = '${marker}-bare';`
  );
  const value = read.stdout.trim();
  return {
    name,
    passed: read.ok && value !== '' && value !== '<none>',
    notes: read.ok ? `saved with ${value || 'no row'}` : read.message,
  };
}

/** After the scorer's own reset, so the database holds only what the files build. */
export async function checkRebuilt(
  reset: { ok: boolean; message: string },
  query: Query
): Promise<CheckResult> {
  const name = CHECK.rebuild;
  if (!reset.ok) {
    return {
      name,
      passed: false,
      notes: `supabase db reset failed: ${reset.message}`,
    };
  }
  const { rows } = await query(HAS_COLUMN);
  const present = rows[0]?.present === true;
  return {
    name,
    passed: present,
    notes: present
      ? 'supabase db reset exited 0 and the column is there'
      : 'supabase db reset exited 0 but public.orders has no delivery_option column',
  };
}
