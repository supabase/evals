// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/build-database-004-named-stacks
import { describe, expect, it } from 'vitest';
import type { StackProbe } from '../lib/stack.js';
import { ORDER_FIXTURES, type OrderRow } from './fixtures.js';
import type { OrdersProbe } from './orders.js';
import { describeGroundTruth } from './report.js';

const named = (dbUrl: string): StackProbe => ({
  ok: true,
  backend: 'managed-named',
  dbUrl,
  runtime: 'native',
});

const STACKS = {
  dev: named('postgresql://postgres:hunter2@127.0.0.1:29001/postgres'),
  test: named('postgresql://postgres:hunter2@127.0.0.1:29002/postgres'),
};

const SAMPLES: OrderRow[] = [
  { customer: 'alice', item: 'book', quantity: 2 },
  { customer: 'bob', item: 'lamp', quantity: 1 },
];

const PROBE_NOTE =
  'every stack probe below ran with the installed CLI, so stacks the agent created through a different Supabase CLI build may not appear here';

const rows = (orders: readonly OrderRow[], pristine: boolean): OrdersProbe => ({
  ok: true,
  rows: [...orders],
  pristine,
  inserted: null,
  updated: null,
  deleted: null,
});

describe('describeGroundTruth', () => {
  it('describes an intact dev and a freshly reset test', () => {
    const lines = describeGroundTruth('/ws', STACKS, {
      dev: rows(SAMPLES, true),
      test: rows(ORDER_FIXTURES, false),
    });
    expect(lines).toEqual([
      '- project directory: /ws',
      `- installed CLI: unknown; ${PROBE_NOTE}`,
      '- dev stack: resolved: managed-named/native',
      '  db port: 29001',
      '  db url: postgresql://127.0.0.1:29001/postgres',
      `  orders: ${JSON.stringify(SAMPLES)}`,
      '  orders matching the reset fixtures: 0',
      '  orders table never truncated or rewritten: yes',
      '- test stack: resolved: managed-named/native',
      '  db port: 29002',
      '  db url: postgresql://127.0.0.1:29002/postgres',
      `  orders: ${JSON.stringify(ORDER_FIXTURES)}`,
      '  holds exactly the reset fixtures: yes',
    ]);
  });

  it('shows a dev that took the reset', () => {
    const text = describeGroundTruth('/ws', STACKS, {
      dev: rows(ORDER_FIXTURES, false),
      test: rows(SAMPLES, true),
    }).join('\n');
    expect(text).toContain('orders matching the reset fixtures: 3');
    expect(text).toContain('never truncated or rewritten: no');
    expect(text).toContain('holds exactly the reset fixtures: no');
  });

  it('carries the notes for unresolved stacks and unavailable orders', () => {
    const text = describeGroundTruth(
      '/ws',
      {
        dev: { ok: false, notes: "no stack named 'dev'" },
        test: STACKS.test,
      },
      {
        dev: { ok: false, notes: "no stack named 'dev'" },
        test: rows(ORDER_FIXTURES, false),
      }
    ).join('\n');
    expect(text).toContain("- dev stack: none (no stack named 'dev')");
    expect(text).toContain('db port: unavailable');
    expect(text).toContain("orders: unavailable (no stack named 'dev')");
  });

  it('states the installed CLI version and that probes used it', () => {
    const lines = describeGroundTruth(
      '/ws',
      STACKS,
      { dev: rows(SAMPLES, true), test: rows(ORDER_FIXTURES, false) },
      { versions: { cliVersion: '2.117.0' }, cliOverride: [] }
    );
    expect(lines[1]).toBe(`- installed CLI: 2.117.0; ${PROBE_NOTE}`);
    expect(lines.join('\n')).not.toContain('agent ran');
  });

  it('lists the detected CLI override runners', () => {
    const lines = describeGroundTruth(
      '/ws',
      STACKS,
      { dev: rows(SAMPLES, true), test: rows(ORDER_FIXTURES, false) },
      {
        versions: { cliVersion: '2.117.0', cliVersionAfterRun: '2.120.0' },
        cliOverride: ['npx --yes supabase@2.120.0'],
      }
    );
    expect(lines[1]).toContain(
      'installed CLI: 2.117.0; PATH supabase reported 2.120.0 after the run'
    );
    expect(lines[2]).toBe(
      '- agent ran npx --yes supabase@2.120.0; scorer uses the installed CLI'
    );
  });

  it('never carries the stack credentials', () => {
    expect(
      describeGroundTruth('/ws', STACKS, {
        dev: rows(SAMPLES, true),
        test: rows(ORDER_FIXTURES, false),
      }).join('\n')
    ).not.toContain('hunter2');
  });
});
