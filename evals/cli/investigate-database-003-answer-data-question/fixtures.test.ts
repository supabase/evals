// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-003-answer-data-question
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import {
  maskSqlLiteralsAndComments,
  migrationCreatesTable,
  stripSqlComments,
} from '../lib/migrations.js';
import { showsAnswerValue } from './answer.js';
import {
  CUSTOMERS_TABLE,
  MIGRATION_FILE,
  ORDERS_TABLE,
  SEED_FILE,
  SEEDED,
} from './fixtures.js';

const evalUrl = (path: string) => new URL(`./${path}`, import.meta.url);
const read = (path: string) => readFileSync(evalUrl(path), 'utf8');

const squash = (sql: string) =>
  sql
    .replace(/\s+/g, ' ')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)/g, ')')
    .trim()
    .toLowerCase();

const statementsOf = (sql: string) =>
  sql
    .split(';')
    .map(squash)
    .filter((statement) => statement.length > 0);

const CUSTOMERS_INSERT = `insert into public.customers (id, email, full_name, created_at)
  select
    md5('customer-' || n)::uuid,
    lower(first_name || '.' || last_name) || n || '@example.com',
    first_name || ' ' || last_name,
    timestamptz '2025-01-01 00:00:00+00' + n * interval '6 hours'
  from generate_series(1, 1200) as n,
    lateral (
      select
        (array['Ada', 'Ben', 'Cleo', 'Dev', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivo', 'Jun', 'Kai', 'Lena'])[1 + n % 12] as first_name,
        (array['Okafor', 'Silva', 'Novak', 'Haddad', 'Larsen', 'Moreau', 'Tanaka', 'Kowalski', 'Reyes', 'Brennan'])[1 + n % 10] as last_name
    ) as names`;

const ORDERS_INSERT = `insert into public.orders (customer_id, total_cents, created_at)
  select
    md5('customer-' || (1 + ('x' || substr(md5('order-' || n), 1, 7))::bit(28)::int % 1200))::uuid,
    500 + (n * 37) % 20000,
    timestamptz '2025-02-01 00:00:00+00' + n * interval '4 hours'
  from generate_series(1, 1800) as n`;

const md5 = (text: string) => createHash('md5').update(text).digest('hex');

// `('x' || substr(md5(...), 1, 7))::bit(28)::int` is the unsigned value of the first 7 hex digits.
const customerNumberOfOrder = (order: number) =>
  1 + (Number.parseInt(md5(`order-${order}`).slice(0, 7), 16) % 1200);

const orderNumbers = Array.from({ length: 1800 }, (_, i) => i + 1);

const PROMPT_BODY =
  "How many of our customers have never placed an order? I'm sending them a win-back email today, so I need the exact number. Can you check the local database with the Supabase CLI?";

const FORBIDDEN_PROMPT_WORDS = [
  'query',
  'queries',
  'sql',
  'psql',
  'select',
  'join',
  'count',
  'table',
  'rls',
  'db',
  'docker',
  'stack',
  'rest',
  'api',
  'studio',
  'dashboard',
  'migration',
  'start',
];

const REQUIRED_PROMPT_PHRASES = [
  'customers',
  'never placed an order',
  'exact number',
  'local database',
  'Supabase CLI',
];

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const wholeWord = (word: string) =>
  new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(word)}(?![A-Za-z0-9_-])`, 'i');

function promptParts() {
  const match = read('PROMPT.md').match(
    /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/
  );
  if (!match) throw new Error('PROMPT.md has no frontmatter');
  return { frontmatter: match[1], body: match[2] };
}

const scalar = (frontmatter: string, key: string) =>
  frontmatter.match(new RegExp(`^${key}: (.+)$`, 'm'))?.[1];

function listItems(frontmatter: string, key: string): string[] {
  const block = frontmatter.match(
    new RegExp(`^${key}:\\r?\\n((?:[ \\t]+-[^\\n]*\\n?)+)`, 'm')
  );
  return (block?.[1] ?? '')
    .split('\n')
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean);
}

describe('fixture constants', () => {
  it('name the two tables and the files that seed them', () => {
    expect(CUSTOMERS_TABLE).toBe('customers');
    expect(ORDERS_TABLE).toBe('orders');
    expect(SEED_FILE).toBe('supabase/seed.sql');
    expect(MIGRATION_FILE).toBe(
      'supabase/migrations/20260101000000_create_customers_and_orders.sql'
    );
  });

  it('carry the facts of the seeded data', () => {
    expect(SEEDED).toEqual({
      customers: 1200,
      orders: 1800,
      orderTotalCents: 17_713_300,
      customersWithOrders: 937,
      neverOrdered: 263,
      customerRowsMd5: '3c6f39b6c129b02f75c591f4d9241008',
      orderRowsMd5: '990777a6ca755d87935959997d3d1165',
    });
  });
});

describe('the facts recomputed from the seed formulas', () => {
  it('generates as many customers and orders as the seeded counts say', () => {
    const series = [
      ...read(`local/${SEED_FILE}`).matchAll(/generate_series\(1,\s*(\d+)\)/g),
    ].map(([, upper]) => Number(upper));
    expect(series).toEqual([SEEDED.customers, SEEDED.orders]);
  });

  it('sums the order totals to the seeded total', () => {
    const total = orderNumbers.reduce(
      (sum, n) => sum + 500 + ((n * 37) % 20000),
      0
    );
    expect(total).toBe(SEEDED.orderTotalCents);
  });

  it('gives every order a customer that exists, so the foreign key holds', () => {
    const customers = orderNumbers.map(customerNumberOfOrder);
    expect(Math.min(...customers)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...customers)).toBeLessThanOrEqual(SEEDED.customers);
  });

  it('gives 937 customers an order and leaves 263 who never ordered', () => {
    const withOrders = new Set(orderNumbers.map(customerNumberOfOrder));
    expect(withOrders.size).toBe(SEEDED.customersWithOrders);
    expect(SEEDED.customers - withOrders.size).toBe(SEEDED.neverOrdered);
  });
});

const asUuid = (hex: string) =>
  [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');

const [firstNames, lastNames] = [
  ...read(`local/${SEED_FILE}`).matchAll(/array\[([^\]]*)\]/g),
].map(([, items]) => [...items.matchAll(/'([^']*)'/g)].map(([, item]) => item));

describe('the seeded customers as a listing shows them', () => {
  const customerRows = Array.from({ length: SEEDED.customers }, (_, i) => {
    const n = i + 1;
    const first = firstNames[n % firstNames.length];
    const last = lastNames[n % lastNames.length];
    return {
      id: asUuid(md5(`customer-${n}`)),
      email: `${first}.${last}${n}@example.com`.toLowerCase(),
      full_name: `${first} ${last}`,
      created_at: new Date(
        Date.UTC(2025, 0, 1) + n * 6 * 3_600_000
      ).toISOString(),
    };
  });

  it('draws names from 12 first names and 10 last names', () => {
    expect([firstNames.length, lastNames.length]).toEqual([12, 10]);
  });

  it('gives every customer a distinct email, so the unique constraint holds', () => {
    expect(new Set(customerRows.map(({ email }) => email)).size).toBe(
      SEEDED.customers
    );
  });

  it('puts the customer number in the email glued to a name, as in ada.okafor263@example.com', () => {
    const [customer] = customerRows.filter(({ email }) =>
      email.includes(`${SEEDED.neverOrdered}@`)
    );
    expect(customer.email).toMatch(/^[a-z]+\.[a-z]+263@example\.com$/);
  });

  it('never prints 263 as a value in a row, so a listing of customers cannot pass for the answer', () => {
    expect(
      customerRows.filter((row) => showsAnswerValue(JSON.stringify(row)))
    ).toEqual([]);
  });

  it('would print it for the old customer-263 style rows, so the guard can fail', () => {
    expect(showsAnswerValue('{"full_name":"Customer 263"}')).toBe(true);
  });
});

describe('the checksums of the seeded rows, rebuilt from the seed model', () => {
  const START = {
    customers: { epoch: Date.UTC(2025, 0, 1) / 1000, hours: 6 },
    orders: { epoch: Date.UTC(2025, 1, 1) / 1000, hours: 4 },
  };

  const field = (value: string | number) => {
    const text = String(value);
    return /[\s,"\\()]/.test(text)
      ? `"${text.replaceAll('\\', '\\\\').replaceAll('"', '""')}"`
      : text;
  };

  const record = (...fields: Array<string | number>) =>
    `(${fields.map(field).join(',')})`;

  const customerRecords = Array.from({ length: SEEDED.customers }, (_, i) => {
    const n = i + 1;
    const id = asUuid(md5(`customer-${n}`));
    const first = firstNames[n % firstNames.length];
    const last = lastNames[n % lastNames.length];
    const epoch = START.customers.epoch + n * START.customers.hours * 3600;
    return {
      id,
      text: record(
        id,
        `${first}.${last}${n}@example.com`.toLowerCase(),
        `${first} ${last}`,
        epoch
      ),
    };
  }).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const orderRecords = orderNumbers
    .map((n) => {
      const epoch = START.orders.epoch + n * START.orders.hours * 3600;
      return {
        epoch,
        text: record(
          asUuid(md5(`customer-${customerNumberOfOrder(n)}`)),
          500 + ((n * 37) % 20000),
          epoch
        ),
      };
    })
    .sort((a, b) => a.epoch - b.epoch);

  it('prints a customer row as a Postgres record, quoting the name and writing the time as epoch seconds', () => {
    expect(customerRecords[0].text).toBe(
      '(0028786a-d34e-724a-eb88-9e5745fff9e0,ada.reyes948@example.com,"Ada Reyes",1756166400)'
    );
  });

  it('hashes the customer rows, ordered by id, to the seeded customer checksum', () => {
    expect(md5(customerRecords.map(({ text }) => text).join(','))).toBe(
      SEEDED.customerRowsMd5
    );
  });

  it('hashes the order rows, ordered by creation time and without the order id, to the seeded order checksum', () => {
    expect(md5(orderRecords.map(({ text }) => text).join(','))).toBe(
      SEEDED.orderRowsMd5
    );
  });

  it('gives the seeded checksums as 32 lowercase hex digits', () => {
    expect(SEEDED.customerRowsMd5).toMatch(/^[0-9a-f]{32}$/);
    expect(SEEDED.orderRowsMd5).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('seeded migration', () => {
  const sql = () => read(`local/${MIGRATION_FILE}`);

  it('is the only migration the project ships', () => {
    expect(readdirSync(evalUrl('local/supabase/migrations/'))).toEqual([
      MIGRATION_FILE.replace('supabase/migrations/', ''),
    ]);
  });

  it('creates public.customers and public.orders', () => {
    expect(migrationCreatesTable(sql(), CUSTOMERS_TABLE)).toBe(true);
    expect(migrationCreatesTable(sql(), ORDERS_TABLE)).toBe(true);
  });

  it('gives customers a uuid id, a unique email, a name and a creation time', () => {
    expect(statementsOf(stripSqlComments(sql()))).toContain(
      squash(`create table public.customers (
        id uuid primary key default gen_random_uuid(),
        email text not null unique,
        full_name text not null,
        created_at timestamptz not null default now()
      )`)
    );
  });

  it('gives orders a uuid id, a customer foreign key, a positive total and a creation time', () => {
    expect(statementsOf(stripSqlComments(sql()))).toContain(
      squash(`create table public.orders (
        id uuid primary key default gen_random_uuid(),
        customer_id uuid not null references public.customers (id),
        total_cents integer not null check (total_cents > 0),
        created_at timestamptz not null default now()
      )`)
    );
  });

  it('creates both tables, one index on orders.customer_id and enables row level security on both, with no policy and nothing else', () => {
    const labels = statementsOf(maskSqlLiteralsAndComments(sql())).map(
      (statement) => {
        const table = statement.match(/^create table public\.(\w+)\(/)?.[1];
        if (table !== undefined) return `create table ${table}`;
        const rls = statement.match(
          /^alter table public\.(\w+) enable row level security$/
        )?.[1];
        if (rls !== undefined) return `enable rls on ${rls}`;
        return /^create index orders_customer_id_idx on public\.orders\(customer_id\)$/.test(
          statement
        )
          ? 'create index orders_customer_id_idx'
          : `unexpected statement: ${statement}`;
      }
    );
    expect(labels.sort()).toEqual([
      'create index orders_customer_id_idx',
      'create table customers',
      'create table orders',
      'enable rls on customers',
      'enable rls on orders',
    ]);
  });
});

describe('seed.sql', () => {
  const seed = () => read(`local/${SEED_FILE}`);

  it('holds exactly the customers insert and the orders insert', () => {
    expect(statementsOf(stripSqlComments(seed()))).toEqual([
      squash(CUSTOMERS_INSERT),
      squash(ORDERS_INSERT),
    ]);
  });

  it('inserts customers before the orders that reference them', () => {
    const sql = seed();
    expect(sql.indexOf('insert into public.customers')).toBeGreaterThanOrEqual(
      0
    );
    expect(sql.indexOf('insert into public.customers')).toBeLessThan(
      sql.indexOf('insert into public.orders')
    );
  });
});

describe('seeded project config', () => {
  it('names the project with the sandbox- prefix the harness sweeps leaked stacks by and loads seed.sql on Postgres 17 with no pinned ports', () => {
    expect(parseToml(read('local/supabase/config.toml'))).toEqual({
      project_id: 'sandbox-shop-crm',
      db: {
        major_version: 17,
        migrations: { enabled: true },
        seed: { enabled: true, sql_paths: ['./seed.sql'] },
      },
    });
  });
});

describe('seeded project layout', () => {
  it('ships only config.toml, the seeded migration and seed.sql', () => {
    expect(
      (readdirSync(evalUrl('local/'), { recursive: true }) as string[]).sort()
    ).toEqual([
      'supabase',
      'supabase/config.toml',
      'supabase/migrations',
      MIGRATION_FILE,
      SEED_FILE,
    ]);
  });

  it.each([
    `local/${MIGRATION_FILE}`,
    `local/${SEED_FILE}`,
    'local/supabase/config.toml',
  ])(
    'does not state the answer or the number of customers who ordered in %s',
    (path) => {
      expect(read(path)).not.toMatch(
        new RegExp(
          `(?<!\\d)(?:${SEEDED.neverOrdered}|${SEEDED.customersWithOrders})(?!\\d)`
        )
      );
    }
  );
});

describe('PROMPT.md', () => {
  it('carries the user message exactly', () => {
    expect(promptParts().body.trim()).toBe(PROMPT_BODY);
  });

  it.each(FORBIDDEN_PROMPT_WORDS)(
    'does not give the agent the word "%s"',
    (word) => {
      expect(promptParts().body).not.toMatch(wholeWord(word));
    }
  );

  it.each(REQUIRED_PROMPT_PHRASES)('mentions "%s"', (phrase) => {
    expect(promptParts().body).toContain(phrase);
  });

  it('declares an investigate-stage CLI eval for SQL on a running project that needs docker', () => {
    const { frontmatter } = promptParts();
    expect(scalar(frontmatter, 'stage')).toBe('investigate');
    expect(scalar(frontmatter, 'interface')).toBe('cli');
    expect(listItems(frontmatter, 'product')).toEqual(['database']);
    expect(listItems(frontmatter, 'topic')).toEqual(['sql']);
    expect(scalar(frontmatter, 'projectRunning')).toBe('true');
    expect(scalar(frontmatter, 'needsDocker')).toBe('true');
    expect(scalar(frontmatter, 'area')).toBe('schema-and-migrations');
    expect(scalar(frontmatter, 'journeyPhase')).toBe('observe');
  });

  it('links CLI-2735 as its motivation', () => {
    expect(scalar(promptParts().frontmatter, 'motivation')).toMatch(
      /^CLI-2735, https:\/\/linear\.app\/supabase\/issue\/CLI-2735\//
    );
  });
});

describe('the whole-word guard', () => {
  it.each([
    ['run db now', true],
    ['(db)', true],
    ['database', false],
    ['db_name', false],
    ['pre-db', false],
  ])('matching "db" in %j is %s', (text, expected) => {
    expect(wholeWord('db').test(text)).toBe(expected);
  });
});
