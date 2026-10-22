// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-005-fix-lint-findings
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_READERS, readSeedFile, SEEDED_MIGRATIONS } from './fixtures.js';

const evalUrl = (path: string) => new URL(`./${path}`, import.meta.url);
const read = (path: string) => readFileSync(evalUrl(path), 'utf8');

const CREATE_ORDERS = '20260101000000_create_orders.sql';
const ORDER_ITEMS_POLICIES = '20260201000000_order_items_policies.sql';
const UNIT_PRICE = '20260301000000_unit_price_and_updated_at.sql';
const migration = (file: string) => read(`local/supabase/migrations/${file}`);

const FORBIDDEN_PROMPT_WORDS = [
  'lint',
  'advisor',
  'advisors',
  'db',
  'rls',
  'policy',
  'policies',
  'search_path',
  'function',
  'migration',
  'migrations',
  'psql',
  'docker',
  'security',
  'performance',
  'order_total',
  'unit_price',
  'stack',
  'reset',
  'sql',
  'start',
  'plpgsql',
];

function promptParts() {
  const match = read('PROMPT.md').match(
    /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/
  );
  if (!match) throw new Error('PROMPT.md has no frontmatter');
  return { frontmatter: match[1], body: match[2] };
}

function topics(frontmatter: string): string[] {
  const block = frontmatter.match(/^topic:\r?\n((?:[ \t]+-[^\n]*\n?)+)/m);
  return (block?.[1] ?? '')
    .split('\n')
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter((line) => line.length > 0);
}

describe('PROMPT.md', () => {
  it('declares a resolve-stage CLI eval for security and sql that needs neither a running project nor docker', () => {
    const { frontmatter } = promptParts();
    expect(frontmatter).toMatch(/^stage: resolve$/m);
    expect(frontmatter).toMatch(/^interface: cli$/m);
    expect(frontmatter).toMatch(/^projectRunning: false$/m);
    expect(frontmatter).toMatch(/^needsDocker: false$/m);
    expect(topics(frontmatter)).toEqual(['security', 'sql']);
  });

  it.each(FORBIDDEN_PROMPT_WORDS)(
    'does not give the agent the word "%s"',
    (word) => {
      expect(promptParts().body).not.toMatch(new RegExp(`\\b${word}\\b`, 'i'));
    }
  );

  it('asks for the database checks to be run on the local database and what they flag to be fixed', () => {
    const { body } = promptParts();
    expect(body).toMatch(/\blocal\b/i);
    expect(body).toMatch(/\bchecks?\b/i);
    expect(body).toMatch(/\bfix/i);
  });
});

describe('SEEDED_MIGRATIONS', () => {
  it('names the three seeded migrations in order', () => {
    expect(SEEDED_MIGRATIONS).toEqual([
      CREATE_ORDERS,
      ORDER_ITEMS_POLICIES,
      UNIT_PRICE,
    ]);
  });

  it('is every migration the project ships', () => {
    expect(readdirSync(evalUrl('local/supabase/migrations/')).sort()).toEqual([
      ...SEEDED_MIGRATIONS,
    ]);
  });
});

describe('seeded migrations plant exactly the five findings', () => {
  it('migration 1 has order_total read oi.price, so renaming the column breaks it', () => {
    const sql = migration(CREATE_ORDERS);
    expect(sql).toMatch(
      /create function public\.order_total\(p_order_id bigint\)/
    );
    expect(sql).toContain('oi.price');
    expect(sql).toMatch(/language plpgsql/);
  });

  it('migration 3 renames price to unit_price', () => {
    expect(migration(UNIT_PRICE)).toMatch(
      /alter table public\.order_items rename column price to unit_price/
    );
  });

  it('never enables row level security on order_items', () => {
    const all = SEEDED_MIGRATIONS.map(migration).join('\n');
    expect(all).not.toMatch(
      /alter\s+table\s+(?:only\s+)?(?:public\.)?order_items\s+enable\s+row\s+level\s+security/i
    );
  });

  it('keeps row level security on orders and a policy on order_items, so order_items has a policy with RLS off', () => {
    expect(migration(CREATE_ORDERS)).toMatch(
      /alter table public\.orders enable row level security/
    );
    expect(migration(ORDER_ITEMS_POLICIES)).toMatch(
      /create policy "Users read their own order items"\s+on public\.order_items/
    );
  });

  it('defines set_updated_at without a search_path', () => {
    const definition = migration(UNIT_PRICE).match(
      /create function public\.set_updated_at\(\)[\s\S]*?\$\$;/
    )?.[0];
    expect(definition).toBeDefined();
    expect(definition).not.toMatch(/search_path/i);
  });

  it('pins order_total to an empty search_path, so set_updated_at is the only mutable one', () => {
    expect(migration(CREATE_ORDERS)).toMatch(/set search_path = ''/);
  });

  it('writes the orders policy with a bare auth.uid()', () => {
    const policy = migration(CREATE_ORDERS).match(
      /create policy "Users read their own orders"[\s\S]*?;/
    )?.[0];
    expect(policy).toBeDefined();
    expect(policy).toMatch(/using \(user_id = auth\.uid\(\)\)/);
    expect(policy).not.toMatch(/select auth\.uid\(\)/i);
  });

  it('wraps auth.uid() in a select in the order_items policy, so only the orders policy is flagged', () => {
    expect(migration(ORDER_ITEMS_POLICIES)).toMatch(/\(select auth\.uid\(\)\)/);
  });
});

describe('APP_READERS', () => {
  const seed = read('local/supabase/seed.sql');
  const orders = [
    ...seed.matchAll(/\((\d+), '([0-9a-f-]{36})', '[^']*'\)/g),
  ].map(([, id, sub]) => ({ id: Number(id), sub }));
  const items = [
    ...seed.matchAll(/\((\d+), '[^']*', (\d+), (\d+(?:\.\d+)?)\)/g),
  ].map(([, orderId, quantity, unitPrice]) => ({
    orderId: Number(orderId),
    total: Number(quantity) * Number(unitPrice),
  }));

  it('lists a reader for every user the seed inserts orders for', () => {
    expect(orders.length).toBeGreaterThan(0);
    expect(APP_READERS.map(({ sub }) => sub).sort()).toEqual(
      [...new Set(orders.map(({ sub }) => sub))].sort()
    );
  });

  it.each(APP_READERS.map((reader) => [reader.sub, reader] as const))(
    'expects the order, item and total counts the seed gives user %s',
    (sub, reader) => {
      const own = orders.filter((order) => order.sub === sub);
      const ownIds = new Set(own.map(({ id }) => id));
      const ownItems = items.filter(({ orderId }) => ownIds.has(orderId));
      const totals = own
        .map(({ id }) =>
          ownItems
            .filter(({ orderId }) => orderId === id)
            .reduce((sum, { total }) => sum + total, 0)
        )
        .sort((a, b) => b - a);

      const expectedTotals = [...reader.totals].sort((a, b) => b - a);

      expect(reader.orders).toBe(own.length);
      expect(reader.items).toBe(ownItems.length);
      expect(expectedTotals).toHaveLength(totals.length);
      expectedTotals.forEach((total, index) => {
        expect(total).toBeCloseTo(totals[index], 2);
      });
    }
  );
});

describe('readSeedFile', () => {
  it.each([
    'supabase/seed.sql',
    'supabase/config.toml',
    `supabase/migrations/${CREATE_ORDERS}`,
    'src/orders.ts',
  ])('returns the contents of local/%s', (path) => {
    expect(readSeedFile(path)).toBe(read(`local/${path}`));
  });

  it('throws when the file is not part of the seed', () => {
    expect(() => readSeedFile('supabase/migrations/missing.sql')).toThrow(
      /ENOENT/
    );
  });
});

describe('seeded app code', () => {
  const code = read('local/src/orders.ts');

  it('reads unit_price through the order_items embed, never the old price column', () => {
    expect(code).toMatch(/\.from\('orders'\)/);
    expect(code).toMatch(/order_items\([^)]*\bunit_price\b[^)]*\)/);
    expect(code).not.toMatch(/\bprice\b/);
  });

  it('calls order_total through rpc with p_order_id', () => {
    expect(code).toMatch(/\.rpc\('order_total',\s*\{\s*p_order_id:/);
  });
});

describe('seeded project config', () => {
  it('names the project and loads seed.sql after the migrations', () => {
    const config = read('local/supabase/config.toml');
    expect(config).toMatch(/^project_id = "orders-app"$/m);
    expect(config).toMatch(/\[db\.seed\]\s+enabled = true/);
    expect(config).toContain('sql_paths = ["./seed.sql"]');
  });
});
