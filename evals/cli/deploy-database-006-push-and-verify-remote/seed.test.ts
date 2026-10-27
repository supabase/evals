// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-database-006-push-and-verify-remote
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stripSqlComments } from '../lib/migrations.js';
import {
  BASE_MIGRATION_VERSION,
  CHANGED_TABLES,
  PLAN_IDS,
  PLANS_COLUMNS,
  PLANS_MIGRATION_FILE,
  PLANS_MIGRATION_VERSION,
  SEEDED_PAID_PROFILES,
  SEEDED_PROFILES,
} from './seed.js';

const read = (path: string) =>
  readFileSync(new URL(`./${path}`, import.meta.url), 'utf8');

const migrationFiles = () =>
  readdirSync(new URL('./local/supabase/migrations/', import.meta.url)).sort();

const normalise = (sql: string) =>
  sql
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),;])\s*/g, '$1')
    .trim()
    .replace(/;$/, '');

const localFile = (name: string) => read(`local/supabase/migrations/${name}`);

const baseFile = () =>
  migrationFiles().find((file) =>
    file.startsWith(`${BASE_MIGRATION_VERSION}_`)
  ) ?? '';

const plansMigration = () => stripSqlComments(localFile(PLANS_MIGRATION_FILE));
const project = stripSqlComments(read('remote/project.sql'));

const historyStatement = (version: string) => {
  const start = project.indexOf(`'${version}'`);
  const rest = project.slice(start + version.length + 2);
  return /array\s*\[\s*'((?:[^']|'')*)'\s*\]/i
    .exec(rest)?.[1]
    .replaceAll("''", "'");
};

describe('seed constants', () => {
  it('name migration files that exist locally, base first', () => {
    expect(migrationFiles()).toContain(PLANS_MIGRATION_FILE);
    expect(baseFile()).not.toBe('');
    expect(PLANS_MIGRATION_FILE.startsWith(`${PLANS_MIGRATION_VERSION}_`)).toBe(
      true
    );
    expect(PLANS_MIGRATION_VERSION > BASE_MIGRATION_VERSION).toBe(true);
  });

  it('are the only two local migration files', () => {
    expect(migrationFiles().map((file) => file.slice(0, 14))).toEqual([
      BASE_MIGRATION_VERSION,
      PLANS_MIGRATION_VERSION,
    ]);
  });

  it('pin the scenario the scorer and the report judge describe', () => {
    expect(PLANS_MIGRATION_VERSION).toBe('20261020120000');
    expect(PLANS_MIGRATION_FILE).toBe('20261020120000_add_plans.sql');
    expect(BASE_MIGRATION_VERSION).toBe('20260901000000');
    expect([...PLAN_IDS]).toEqual(['free', 'pro']);
    expect([...PLANS_COLUMNS]).toEqual(['id', 'name', 'monthly_price_cents']);
    expect([...CHANGED_TABLES]).toEqual(['plans', 'profiles']);
  });
});

describe('remote seed', () => {
  it('records the base migration and not the plans migration', () => {
    const versions = [...project.matchAll(/'(\d{14})'/g)].map(
      (match) => match[1]
    );
    expect(versions).toEqual([BASE_MIGRATION_VERSION]);
    expect(versions).not.toContain(PLANS_MIGRATION_VERSION);
  });

  it('records the base migration with the SQL of the local base file', () => {
    expect(normalise(historyStatement(BASE_MIGRATION_VERSION) ?? '')).toBe(
      normalise(localFile(baseFile()))
    );
  });

  it('declares the migration history table the CLI reads', () => {
    expect(project).toMatch(
      /create table (?:if not exists )?supabase_migrations\.schema_migrations\s*\(/i
    );
    expect(project).toMatch(/version\s+text\s+not null\s+primary key/i);
    expect(project).toMatch(/statements\s+text\[\]/i);
  });

  it('seeds SEEDED_PROFILES users named user_<n>', () => {
    const bounds = [
      ...project.matchAll(/generate_series\(\s*1\s*,\s*(\d+)\s*\)/gi),
    ].map((match) => Number(match[1]));
    expect(bounds).toEqual([SEEDED_PROFILES]);
    expect(project).toMatch(/'user_'\s*\|\|\s*n/);
  });

  it('marks every nth user paid, which makes SEEDED_PAID_PROFILES paid', () => {
    const modulus = Number(/n\s*%\s*(\d+)\s*=\s*0/.exec(project)?.[1]);
    expect(modulus).toBeGreaterThan(0);
    const paid = Array.from(
      { length: SEEDED_PROFILES },
      (_, index) => index + 1
    ).filter((n) => n % modulus === 0).length;
    expect(paid).toBe(SEEDED_PAID_PROFILES);
  });

  it('seeds profiles that have is_paid and no plan_id, and no plans table', () => {
    expect(project).toMatch(/is_paid\s+boolean\s+not null\s+default\s+false/i);
    expect(project).not.toContain('plan_id');
    expect(project).not.toMatch(
      /create table (?:if not exists )?public\.plans/i
    );
  });
});

describe('plans migration', () => {
  it('creates public.plans with exactly the PLANS_COLUMNS, in order', () => {
    const body =
      /create table public\.plans\s*\(([\s\S]*?)\n\)\s*;/i.exec(
        plansMigration()
      )?.[1] ?? '';
    const columns = body
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((name) => name !== '');
    expect(columns).toEqual([...PLANS_COLUMNS]);
  });

  it('inserts exactly the PLAN_IDS', () => {
    const values =
      /insert into public\.plans\s*\([^)]*\)\s*values([\s\S]*?);/i.exec(
        plansMigration()
      )?.[1] ?? '';
    expect([...values.matchAll(/\(\s*'(\w+)'/g)].map((m) => m[1])).toEqual([
      ...PLAN_IDS,
    ]);
  });

  it('adds profiles.plan_id as a not-null column that references plans', () => {
    const sql = normalise(plansMigration());
    expect(sql).toContain(
      normalise(
        'alter table public.profiles add column plan_id text references public.plans (id)'
      )
    );
    expect(sql).toContain(
      normalise('alter table public.profiles alter column plan_id set not null')
    );
  });

  it('moves paid users to pro and everyone else to free', () => {
    expect(normalise(plansMigration())).toContain(
      normalise(
        "update public.profiles set plan_id = case when is_paid then 'pro' else 'free' end"
      )
    );
  });

  it('changes exactly the CHANGED_TABLES', () => {
    const tables = new Set(
      [
        ...plansMigration().matchAll(
          /(?:create|alter) table (?:public\.)?(\w+)/gi
        ),
      ].map((match) => match[1])
    );
    expect([...tables].sort()).toEqual([...CHANGED_TABLES].sort());
  });
});

describe('local project', () => {
  it('configures a Postgres 17 project without ports', () => {
    const config = read('local/supabase/config.toml');
    expect(config).toMatch(/^project_id\s*=\s*"plans-app"\s*$/m);
    expect(config).toMatch(/^\[db\]\s*$/m);
    expect(config).toMatch(/^major_version\s*=\s*17\s*$/m);
    expect(config).not.toMatch(/port\s*=/i);
  });
});

describe('PROMPT.md', () => {
  const prompt = read('PROMPT.md');
  const [, frontmatter = '', body = ''] = prompt.split(/^---\s*$/m);

  it('names no command, flag, path, version, table or column', () => {
    expect(body.trim()).not.toBe('');
    expect(body).not.toMatch(
      /supabase|docker|psql|\bcli\b|\bdb\b|--|\blinked?\b|\bremote\b|login|token|\bref\b|management api|\blocal\b|plan_id|is_paid|\bprofiles?\b|\.sql|\d{6,}/i
    );
    expect(body.trim().split(/\s+/).length).toBeLessThan(80);
  });

  it('keeps the words a user would say', () => {
    for (const word of [
      'migration',
      'subscription plans',
      'existing users',
      'push',
      'our project',
      'live database',
    ]) {
      expect(body).toContain(word);
    }
  });

  it('declares a deploy-stage CLI journey that needs neither Docker nor a running project', () => {
    expect(frontmatter).toMatch(/^stage: deploy$/m);
    expect(frontmatter).toMatch(/^interface: cli$/m);
    expect(frontmatter).toMatch(/^needsDocker: false$/m);
    expect(frontmatter).toMatch(/^projectRunning: false$/m);
    expect(frontmatter).toMatch(/^product:\s*\n\s*- database\s*$/m);
    expect(frontmatter).toMatch(
      /^topic:\s*\n\s*- migrations\s*\n\s*- sql\s*$/m
    );
  });

  it('leaves hostedProject unset so the run stays red until a hosted project exists', () => {
    expect(frontmatter).not.toMatch(/^hostedProject:/m);
  });

  it('cites the ticket the scenario comes from', () => {
    const motivation = /^motivation:(.*)$/m.exec(frontmatter)?.[1] ?? '';
    expect(motivation).toContain('CLI-2734');
    expect(motivation).toContain('https://linear.app/supabase/issue/CLI-2734');
  });
});
