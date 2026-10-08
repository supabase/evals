// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/build-database-004-named-stacks
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  diffAgainstFixtures,
  isFixtureRow,
  ORDER_FIXTURES,
  type OrderRow,
} from './fixtures.js';

const localFile = (path: string) =>
  readFileSync(new URL(`./local/${path}`, import.meta.url), 'utf8');

describe('ORDER_FIXTURES', () => {
  it('matches the rows the seeded reset script inserts', () => {
    const script = localFile('scripts/reset-test-data.sql');
    const inserted = [
      ...script.matchAll(/\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*(\d+)\s*\)/g),
    ].map(([, customer, item, quantity]) => ({
      customer,
      item,
      quantity: Number(quantity),
    }));
    expect(inserted).toEqual(ORDER_FIXTURES);
  });

  it('is loaded by the seeded reset script after it truncates the table', () => {
    const script = localFile('scripts/reset-test-data.sql');
    expect(script).toMatch(/truncate table public\.orders/i);
    expect(script).toMatch(
      /insert into public\.orders \(customer, item, quantity\)/i
    );
  });

  it('is reached by the seeded package script', () => {
    const pkg = JSON.parse(localFile('package.json'));
    expect(pkg.scripts['db:reset-test']).toContain(
      'scripts/reset-test-data.sql'
    );
  });
});

describe('seeded config.toml', () => {
  it('pins no api or db port, or named stacks from one config would collide', () => {
    let section = '';
    const pinned: string[] = [];
    for (const line of localFile('supabase/config.toml').split('\n')) {
      const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
      if (header) section = header[1].trim();
      else if (
        /^(?:api|db)$/.test(section) &&
        /^\s*(?:port|shadow_port)\s*=/.test(line)
      ) {
        pinned.push(`[${section}] ${line.trim()}`);
      }
    }
    expect(pinned).toEqual([]);
  });
});

describe('isFixtureRow', () => {
  it('recognises a fixture row and any row for a fixture customer', () => {
    expect(isFixtureRow(ORDER_FIXTURES[0])).toBe(true);
    expect(
      isFixtureRow({
        customer: 'fixture-customer-2',
        item: 'other',
        quantity: 9,
      })
    ).toBe(true);
  });

  it('does not recognise ordinary sample orders', () => {
    expect(
      isFixtureRow({ customer: 'alice', item: 'fixture-widget', quantity: 1 })
    ).toBe(false);
    expect(isFixtureRow({ customer: 'bob', item: 'book', quantity: 2 })).toBe(
      false
    );
  });
});

describe('diffAgainstFixtures', () => {
  it('reports nothing for exactly the fixtures, in any order', () => {
    expect(diffAgainstFixtures([...ORDER_FIXTURES].reverse())).toEqual({
      missing: [],
      unexpected: [],
    });
  });

  it('reports a leftover sample row as unexpected', () => {
    const sample: OrderRow = { customer: 'alice', item: 'book', quantity: 1 };
    expect(diffAgainstFixtures([...ORDER_FIXTURES, sample])).toEqual({
      missing: [],
      unexpected: [sample],
    });
  });

  it('reports a missing fixture', () => {
    expect(diffAgainstFixtures(ORDER_FIXTURES.slice(1)).missing).toEqual([
      ORDER_FIXTURES[0],
    ]);
  });

  it('counts a duplicated fixture as unexpected', () => {
    expect(
      diffAgainstFixtures([...ORDER_FIXTURES, ORDER_FIXTURES[0]]).unexpected
    ).toEqual([ORDER_FIXTURES[0]]);
  });

  it('treats an empty table as every fixture missing', () => {
    expect(diffAgainstFixtures([])).toEqual({
      missing: [...ORDER_FIXTURES],
      unexpected: [],
    });
  });
});
