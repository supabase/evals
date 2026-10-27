// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-database-007-dump-before-push
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripSqlComments } from '../lib/migrations.js';
import { COUPONS, SEEDED_EMAILS } from './fixtures.js';
import {
  BASE_MIGRATION_FILE,
  BASE_MIGRATION_VERSION,
  COUPON_CODES,
  DROP_MIGRATION_FILE,
  DROP_MIGRATION_VERSION,
  DROPPED_TABLE,
  KEPT_TABLE,
  SEEDED_CUSTOMERS,
} from './seed.js';

const here = (path: string) => new URL(`./${path}`, import.meta.url);
const read = (path: string) => readFileSync(here(path), 'utf8');

const migrationFiles = () =>
  readdirSync(here('local/supabase/migrations/')).sort();

const normalise = (sql: string) =>
  sql
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),;])\s*/g, '$1')
    .trim()
    .replace(/;$/, '');

const localFile = (name: string) => read(`local/supabase/migrations/${name}`);

const baseMigration = () => stripSqlComments(localFile(BASE_MIGRATION_FILE));
const dropMigration = () => stripSqlComments(localFile(DROP_MIGRATION_FILE));
const project = stripSqlComments(read('remote/project.sql'));

const STATEMENT_ARRAY =
  /array\s*\[\s*'(?:[^']|'')*'(?:\s*,\s*'(?:[^']|'')*')*\s*\]/gi;
const projectOutsideHistory = project.replace(STATEMENT_ARRAY, '');

const historyStatements = (version: string): string[] => {
  const start = project.indexOf(`'${version}'`);
  const rest = project.slice(start + version.length + 2);
  const array = new RegExp(STATEMENT_ARRAY.source, 'i').exec(rest)?.[0] ?? '';
  return [...array.matchAll(/'((?:[^']|'')*)'/g)].map((match) =>
    match[1].replaceAll("''", "'")
  );
};

const filesUnder = (path: string): string[] => {
  const root = fileURLToPath(here(path));
  return readdirSync(root, { recursive: true })
    .map((entry) => `${root}/${entry}`)
    .filter((entry) => statSync(entry).isFile());
};

describe('seed constants', () => {
  it('pin the scenario the scorer and the report judge describe', () => {
    expect(BASE_MIGRATION_VERSION).toBe('20260801000000');
    expect(BASE_MIGRATION_FILE).toBe('20260801000000_create_shop.sql');
    expect(DROP_MIGRATION_VERSION).toBe('20261027090000');
    expect(DROP_MIGRATION_FILE).toBe('20261027090000_drop_legacy_coupons.sql');
    expect(DROPPED_TABLE).toBe('public.legacy_coupons');
    expect(KEPT_TABLE).toBe('public.customers');
  });

  it('list the 8 seeded customers', () => {
    expect([...SEEDED_CUSTOMERS]).toEqual([...SEEDED_EMAILS]);
    expect(new Set(SEEDED_CUSTOMERS).size).toBe(8);
  });

  it('list the 15 distinct coupon codes', () => {
    expect([...COUPON_CODES]).toEqual([...COUPONS]);
    expect(new Set(COUPON_CODES).size).toBe(15);
    for (const code of COUPON_CODES) {
      expect(code).toMatch(/^LGCY-[A-Z0-9]{6}$/);
    }
  });

  it('name migration files that exist locally, base first', () => {
    expect(migrationFiles()).toContain(BASE_MIGRATION_FILE);
    expect(migrationFiles()).toContain(DROP_MIGRATION_FILE);
    expect(BASE_MIGRATION_FILE.startsWith(`${BASE_MIGRATION_VERSION}_`)).toBe(
      true
    );
    expect(DROP_MIGRATION_FILE.startsWith(`${DROP_MIGRATION_VERSION}_`)).toBe(
      true
    );
    expect(DROP_MIGRATION_VERSION > BASE_MIGRATION_VERSION).toBe(true);
  });

  it('are the only two local migration files', () => {
    expect(migrationFiles()).toEqual([
      BASE_MIGRATION_FILE,
      DROP_MIGRATION_FILE,
    ]);
  });
});

describe('base migration', () => {
  it('creates public.customers with an identity id and a unique email', () => {
    expect(normalise(baseMigration())).toContain(
      normalise(
        `create table ${KEPT_TABLE} (
          id bigint generated always as identity primary key,
          email text not null unique,
          created_at timestamptz not null default now()
        )`
      )
    );
  });

  it('creates public.legacy_coupons with a code key and a reference to customers', () => {
    expect(normalise(baseMigration())).toContain(
      normalise(
        `create table ${DROPPED_TABLE} (
          code text primary key,
          customer_id bigint references ${KEPT_TABLE} (id),
          percent_off integer not null,
          issued_at timestamptz not null default now(),
          redeemed_at timestamptz
        )`
      )
    );
  });

  it('creates exactly those two tables', () => {
    const tables = [
      ...baseMigration().matchAll(/create table (?:if not exists )?([\w.]+)/gi),
    ].map((match) => match[1]);
    expect(tables).toEqual([KEPT_TABLE, DROPPED_TABLE]);
  });
});

describe('drop migration', () => {
  it('drops public.legacy_coupons and nothing else', () => {
    expect(normalise(dropMigration())).toBe(`drop table ${DROPPED_TABLE}`);
  });

  it('leaves the customers table alone', () => {
    expect(dropMigration()).not.toMatch(/customers/i);
  });
});

describe('remote seed', () => {
  it('records the base migration and not the drop migration', () => {
    const versions = [...project.matchAll(/'(\d{14})'/g)].map(
      (match) => match[1]
    );
    expect(versions).toEqual([BASE_MIGRATION_VERSION]);
    expect(versions).not.toContain(DROP_MIGRATION_VERSION);
  });

  it('records the base migration as one statement per array element, as the CLI does', () => {
    const statements = historyStatements(BASE_MIGRATION_VERSION);
    expect(statements).toHaveLength(2);
    expect(statements.map(normalise)).toEqual([
      normalise(
        `create table ${KEPT_TABLE} (
          id bigint generated always as identity primary key,
          email text not null unique,
          created_at timestamptz not null default now()
        )`
      ),
      normalise(
        `create table ${DROPPED_TABLE} (
          code text primary key,
          customer_id bigint references ${KEPT_TABLE} (id),
          percent_off integer not null,
          issued_at timestamptz not null default now(),
          redeemed_at timestamptz
        )`
      ),
    ]);
    for (const statement of statements) {
      expect(statement.trim()).toMatch(/\);$/);
    }
  });

  it('records the base migration with the SQL of the local base file', () => {
    expect(
      normalise(historyStatements(BASE_MIGRATION_VERSION).join('\n'))
    ).toBe(normalise(localFile(BASE_MIGRATION_FILE)));
  });

  it('declares the migration history table the CLI reads', () => {
    expect(project).toMatch(
      /create table (?:if not exists )?supabase_migrations\.schema_migrations\s*\(/i
    );
    expect(project).toMatch(/version\s+text\s+not null\s+primary key/i);
    expect(project).toMatch(/statements\s+text\[\]/i);
  });

  it('opens with the comment that says it is read once hostedProject is enabled', () => {
    expect(read('remote/project.sql').split('\n')[0]).toBe(
      '-- Hosted project state; read once the eval enables hostedProject.'
    );
  });

  it('creates both tables as the base migration does', () => {
    expect(normalise(projectOutsideHistory)).toContain(
      normalise(
        `create table ${KEPT_TABLE} (
          id bigint generated always as identity primary key,
          email text not null unique,
          created_at timestamptz not null default now()
        )`
      )
    );
    expect(normalise(projectOutsideHistory)).toContain(
      normalise(
        `create table ${DROPPED_TABLE} (
          code text primary key,
          customer_id bigint references ${KEPT_TABLE} (id),
          percent_off integer not null,
          issued_at timestamptz not null default now(),
          redeemed_at timestamptz
        )`
      )
    );
  });

  it('holds all 8 customer emails and no other customer', () => {
    for (const email of SEEDED_CUSTOMERS) {
      expect(project).toContain(email);
    }
    const emails = [...project.matchAll(/customer\d+@example\.com/g)].map(
      (match) => match[0]
    );
    expect(new Set(emails)).toEqual(new Set(SEEDED_CUSTOMERS));
  });

  it('holds each of the 15 coupon codes once and no other code', () => {
    const codes = [...projectOutsideHistory.matchAll(/LGCY-[A-Z0-9]{6}/g)].map(
      (match) => match[0]
    );
    expect(codes.slice().sort()).toEqual([...COUPON_CODES].sort());
  });

  it('keeps the coupon codes out of the recorded migration statements', () => {
    expect(historyStatements(BASE_MIGRATION_VERSION).join('\n')).not.toMatch(
      /LGCY-/
    );
  });
});

describe('local project', () => {
  it('configures a Postgres 17 project called shop-app without ports', () => {
    const config = read('local/supabase/config.toml');
    expect(config).toMatch(/^project_id\s*=\s*"shop-app"\s*$/m);
    expect(config).toMatch(/^\[db\]\s*$/m);
    expect(config).toMatch(/^major_version\s*=\s*17\s*$/m);
    expect(config).not.toMatch(/port\s*=/i);
  });

  it('ignores node_modules and the .env files at the root', () => {
    const lines = read('local/.gitignore')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    expect(lines).toEqual([
      'node_modules',
      '.env',
      '.env.local',
      '.env.*.local',
    ]);
  });

  it('ignores the CLI link state under supabase/', () => {
    const lines = read('local/supabase/.gitignore')
      .split('\n')
      .map((line) => line.trim());
    expect(lines).toContain('.temp');
    expect(lines).toContain('.branches');
  });

  it('holds no coupon code in any file, so a backup is the only copy of them outside the hosted project', () => {
    const files = filesUnder('local');
    expect(files.length).toBeGreaterThan(0);
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      for (const code of COUPON_CODES) {
        expect(text, path).not.toContain(code);
      }
      expect(text, path).not.toMatch(/LGCY-[A-Z0-9]{6}/);
    }
  });
});

describe('PROMPT.md', () => {
  const prompt = read('PROMPT.md');
  const [, frontmatter = '', body = ''] = prompt.split(/^---\s*$/m);

  it('names no command, flag, path, version, table, column or runtime', () => {
    expect(body.trim()).not.toBe('');
    expect(body).not.toMatch(
      /supabase|docker|psql|pg_dump|\bdump|\bcli\b|\bdb\b|--|\blinked?\b|\bremote\b|login|token|\bref\b|management api|\blocal\b|\bschema\b|\btables?\b|coupons?|customers?|data-only|\.sql|\d{6,}/i
    );
    expect(body.trim().split(/\s+/).length).toBeLessThan(80);
  });

  it('keeps the words a user would say', () => {
    for (const word of [
      'migration',
      'old data',
      'backup',
      'live database',
      'restore',
      'push',
      'our project',
    ]) {
      expect(body).toContain(word);
    }
  });

  it('declares a deploy-stage CLI journey that needs Docker but no running project', () => {
    expect(frontmatter).toMatch(/^stage: deploy$/m);
    expect(frontmatter).toMatch(/^interface: cli$/m);
    expect(frontmatter).toMatch(/^needsDocker: true$/m);
    expect(frontmatter).toMatch(/^projectRunning: false$/m);
    expect(frontmatter).toMatch(/^product:\s*\n\s*- database\s*$/m);
    expect(frontmatter).toMatch(/^topic:\s*\n\s*- migrations\s*$/m);
    expect(frontmatter).toMatch(/^area: schema-and-migrations$/m);
    expect(frontmatter).toMatch(/^journeyPhase: deploy$/m);
  });

  it('leaves hostedProject unset so the run stays red until a hosted project exists', () => {
    expect(frontmatter).not.toMatch(/^hostedProject:/m);
  });

  it('cites the ticket the scenario comes from', () => {
    const motivation = /^motivation:(.*)$/m.exec(frontmatter)?.[1] ?? '';
    expect(motivation).toContain('CLI-2738');
    expect(motivation).toContain('https://linear.app/supabase/issue/CLI-2738');
  });
});
