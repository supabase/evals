// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-001-slow-query
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { migrationCreatesTable } from '../lib/migrations.js';
import {
  EMAIL_COLUMN,
  LOOKUP_QUERY,
  ORDERS_TABLE,
  PROBE_CUSTOMER,
  SEEDED_MIGRATION_FILE,
  SEEDED_MIGRATION_SHA256,
  SEEDED_MIGRATION_VERSION,
  SEEDED_ORDER_COUNT,
} from './fixtures.js';

const evalUrl = (path: string) => new URL(`./${path}`, import.meta.url);
const read = (path: string) => readFileSync(evalUrl(path), 'utf8');
const seededMigrationPath = `local/supabase/migrations/${SEEDED_MIGRATION_FILE}`;

const PROMPT_BODY =
  "Our app keeps getting slower and I'm fairly sure the database is the bottleneck. Can you use the Supabase CLI to dig into our local database, work out what's actually slow, and fix it? Make sure the fix is saved in the project so it ships with everything else, not just applied on my machine.";

const FORBIDDEN_PROMPT_WORDS = [
  'inspect',
  'index',
  'query',
  'queries',
  'scan',
  'migration',
  'orders',
  'customer',
  'email',
  'explain',
  'psql',
  'docker',
  'stack',
  'sql',
  'table',
  'outlier',
  'stat',
  'seq',
  'reset',
  'start',
  'vacuum',
  'bloat',
  'lock',
];

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
    new RegExp(`^${key}:\\n((?: {2}- .+\\n?)+)`, 'm')
  );
  return (block?.[1] ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.replace(/^\s*- /, ''));
}

const statements = (sql: string) =>
  sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

const CUSTOMER_LOOKUP_RE =
  /^select id, status, total_cents, created_at from public\.orders where customer_email = '(customer-(\d+)@example\.com)' order by created_at desc limit 20$/;
const ID_LOOKUP_RE =
  /^select id, customer_email, status, total_cents, created_at from public\.orders where id = (\d+)$/;

describe('fixture constants', () => {
  it('name the table, the column and the seeded volume', () => {
    expect(ORDERS_TABLE).toBe('orders');
    expect(EMAIL_COLUMN).toBe('customer_email');
    expect(SEEDED_ORDER_COUNT).toBe(300_000);
  });

  it('carry the seeded migration checksum as a sha256 hex digest', () => {
    expect(SEEDED_MIGRATION_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('name the seeded migration by its version', () => {
    expect(SEEDED_MIGRATION_VERSION).toBe('20260101000000');
    expect(SEEDED_MIGRATION_FILE).toBe(
      `${SEEDED_MIGRATION_VERSION}_create_orders.sql`
    );
  });

  it('build the order-history lookup for a customer the seed never replays', () => {
    expect(PROBE_CUSTOMER).toBe('customer-42@example.com');
    expect(LOOKUP_QUERY).toBe(
      "select id, status, total_cents, created_at from public.orders where customer_email = 'customer-42@example.com' order by created_at desc limit 20"
    );
  });
});

describe('seeded migration', () => {
  it('has the checksum the scorer compares against', () => {
    const digest = createHash('sha256')
      .update(readFileSync(evalUrl(seededMigrationPath)))
      .digest('hex');
    expect(digest).toBe(SEEDED_MIGRATION_SHA256);
  });

  it('creates public.orders with customer_email and no index but the primary key', () => {
    const sql = read(seededMigrationPath);
    expect(migrationCreatesTable(sql, ORDERS_TABLE)).toBe(true);
    expect(sql).toMatch(/customer_email text not null/);
    expect(sql).toMatch(/id bigint generated always as identity primary key/);
    expect(sql).not.toMatch(/\bindex\b/i);
    expect(sql).not.toMatch(/\bunique\b/i);
  });

  it('is the only migration the project ships', () => {
    expect(readdirSync(evalUrl('local/supabase/migrations/'))).toEqual([
      SEEDED_MIGRATION_FILE,
    ]);
  });
});

describe('seed.sql', () => {
  const seed = () => read('local/supabase/seed.sql');

  it('bulk-loads the seeded orders from 5000 customers in one insert', () => {
    expect(seed()).toMatch(
      /insert into public\.orders \(customer_email, status, total_cents, created_at\)/
    );
    expect(seed()).toMatch(
      new RegExp(`generate_series\\(1,\\s*${SEEDED_ORDER_COUNT}\\)`)
    );
    expect(seed()).toMatch(/n % 5000/);
    expect(seed().match(/insert into/gi)).toHaveLength(1);
  });

  it('analyzes orders after the load and before the first replayed request', () => {
    const sql = seed();
    const analyze = sql.indexOf('analyze public.orders;');
    expect(analyze).toBeGreaterThan(sql.indexOf('insert into public.orders'));
    expect(analyze).toBeLessThan(sql.indexOf('select id, '));
  });

  it('replays 200 order-history lookups and 100 lookups by primary key', () => {
    const all = statements(seed());
    expect(all.filter((sql) => CUSTOMER_LOOKUP_RE.test(sql))).toHaveLength(200);
    expect(all.filter((sql) => ID_LOOKUP_RE.test(sql))).toHaveLength(100);
  });

  it('holds nothing but the load, the analyze and the 300 replayed requests', () => {
    expect(statements(seed())).toHaveLength(302);
  });

  it('replays the order-history lookup in exactly the shape the scorer explains', () => {
    const lookup = statements(seed()).find((sql) =>
      CUSTOMER_LOOKUP_RE.test(sql)
    ) as string;
    const customer = lookup.match(CUSTOMER_LOOKUP_RE)?.[1] as string;
    expect(lookup.replace(customer, PROBE_CUSTOMER)).toBe(LOOKUP_QUERY);
  });

  it('interleaves the two kinds of request', () => {
    const first = statements(seed())
      .filter((sql) => CUSTOMER_LOOKUP_RE.test(sql) || ID_LOOKUP_RE.test(sql))
      .slice(0, 6)
      .map((sql) => (ID_LOOKUP_RE.test(sql) ? 'id' : 'customer'));
    expect(new Set(first)).toEqual(new Set(['id', 'customer']));
  });

  it('looks up customers and ids that exist in the loaded data', () => {
    const numbers = (re: RegExp, group: number) =>
      statements(seed()).flatMap((sql) => {
        const match = sql.match(re);
        return match ? [Number(match[group])] : [];
      });
    const customers = numbers(CUSTOMER_LOOKUP_RE, 2);
    const ids = numbers(ID_LOOKUP_RE, 1);
    expect(customers).toHaveLength(200);
    expect(ids).toHaveLength(100);
    expect(customers.every((n) => n < 5000)).toBe(true);
    expect(ids.every((n) => n >= 1 && n <= SEEDED_ORDER_COUNT)).toBe(true);
  });

  it('never replays the customer the scorer probes with', () => {
    expect(seed()).not.toContain(PROBE_CUSTOMER);
  });

  it('does not create an index', () => {
    expect(seed()).not.toMatch(/create\s+(?:unique\s+)?index/i);
  });
});

describe('seeded project layout', () => {
  it('is loaded from seed.sql by config.toml on a Postgres 17 project without pinned ports', () => {
    const config = read('local/supabase/config.toml');
    expect(config).toMatch(/^project_id = "shop-app"$/m);
    expect(config).toMatch(/\[db\]\s+major_version = 17/);
    expect(config).toMatch(/\[db\.migrations\]\s+enabled = true/);
    expect(config).toMatch(/\[db\.seed\]\s+enabled = true/);
    expect(config).toContain('sql_paths = ["./seed.sql"]');
    expect(config).not.toMatch(/^\s*port\s*=/m);
  });

  it.each(['local/package.json', 'local/.env', 'local/supabase/schemas'])(
    'ships no %s, so nothing steers the agent to a package runner or a declarative schema',
    (path) => {
      expect(existsSync(evalUrl(path))).toBe(false);
    }
  );

  it('ships only the supabase directory, with no app code', () => {
    expect(readdirSync(evalUrl('local/'))).toEqual(['supabase']);
    expect(readdirSync(evalUrl('local/supabase/')).sort()).toEqual([
      'config.toml',
      'migrations',
      'seed.sql',
    ]);
  });
});

describe('PROMPT.md', () => {
  it('carries the user message exactly', () => {
    expect(promptParts().body.trim()).toBe(PROMPT_BODY);
  });

  it.each(FORBIDDEN_PROMPT_WORDS)(
    'does not give the agent the word "%s"',
    (word) => {
      expect(promptParts().body.toLowerCase()).not.toContain(word);
    }
  );

  it('keeps the words a user who knows the tool but not the subcommand would use', () => {
    const { body } = promptParts();
    for (const phrase of ['Supabase CLI', 'local database', 'slow', 'fix']) {
      expect(body).toContain(phrase);
    }
  });

  it('declares a CLI eval that investigates diagnostics and starts without a running project or docker', () => {
    const { frontmatter } = promptParts();
    expect(scalar(frontmatter, 'stage')).toBe('investigate');
    expect(scalar(frontmatter, 'interface')).toBe('cli');
    expect(listItems(frontmatter, 'product')).toEqual(['database']);
    expect(listItems(frontmatter, 'topic').sort()).toEqual([
      'migrations',
      'observability',
    ]);
    expect(scalar(frontmatter, 'projectRunning')).toBe('false');
    expect(scalar(frontmatter, 'needsDocker')).toBe('false');
    expect(scalar(frontmatter, 'area')).toBe('diagnostics');
    expect(scalar(frontmatter, 'journeyPhase')).toBe('observe');
  });

  it.each(['CLI-2712', 'FDBKIN-1481', 'FDBKIN-1663', 'FDBKIN-13604'])(
    'cites %s as motivation',
    (id) => {
      expect(scalar(promptParts().frontmatter, 'motivation')).toContain(id);
    }
  );
});
