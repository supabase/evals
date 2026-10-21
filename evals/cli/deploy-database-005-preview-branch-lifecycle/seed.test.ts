// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-database-005-preview-branch-lifecycle
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { migrationCreatesTable, stripSqlComments } from '../lib/migrations.js';
import {
  BASELINE_FILE,
  BASELINE_TABLE,
  BASELINE_VERSION,
  NEW_MIGRATION_FILE,
  NEW_MIGRATION_VERSION,
  NEW_TABLE,
  SEEDED_ORDERS,
} from './seed.js';

const here = (path: string) => new URL(`./${path}`, import.meta.url);
const read = (path: string) => readFileSync(here(path), 'utf8');

const normalise = (sql: string) =>
  sql
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),;])\s*/g, '$1')
    .trim()
    .replace(/;$/, '');

const CREATE_ORDERS =
  'create table public.orders (id bigint generated always as identity primary key, customer_email text not null, total_cents integer not null check (total_cents >= 0), created_at timestamptz not null default now())';

const PROMPT =
  "I've just written a new migration and I don't want it anywhere near production until I've seen it work. Can you spin up a preview branch of our project, try the migration out on it, check it actually does what it's meant to, and then clean the branch up?";

const BANNED_WORDS = [
  'supabase',
  'branches',
  'create',
  'delete',
  'remove',
  'push',
  'link',
  'db',
  'sql',
  'shipments',
  'shipment',
  'orders',
  'tracking',
  'carrier',
  'docker',
  'ref',
  'url',
  'persistent',
  'staging',
  'local',
];

const BANNED_STEMS = ['creat', 'delet', 'remov', 'push', 'link'];

const BANNED_FRAGMENTS = ['--', 'supabase/', '.sql'];

const KEPT_WORDS = ['preview branch', 'migration', 'production', 'clean'];

const prompt = read('PROMPT.md');
const [, frontmatter = '', body = ''] = prompt.split(/^---\s*$/m);

const migration = (file: string) => read(`local/supabase/migrations/${file}`);

const migrationSql = (file: string) =>
  normalise(stripSqlComments(migration(file)));

describe('seed constants', () => {
  it('describe the baseline already on production and the new migration', () => {
    expect(BASELINE_VERSION).toBe('20260301090000');
    expect(BASELINE_FILE).toBe('20260301090000_create_orders.sql');
    expect(BASELINE_TABLE).toBe('orders');
    expect(SEEDED_ORDERS).toBe(12);
    expect(NEW_MIGRATION_VERSION).toBe('20261020120000');
    expect(NEW_MIGRATION_FILE).toBe('20261020120000_add_order_shipments.sql');
    expect(NEW_TABLE).toBe('shipments');
  });

  it('put the version at the front of each file name', () => {
    expect(BASELINE_FILE.startsWith(`${BASELINE_VERSION}_`)).toBe(true);
    expect(NEW_MIGRATION_FILE.startsWith(`${NEW_MIGRATION_VERSION}_`)).toBe(
      true
    );
  });

  it('order the new migration after the baseline', () => {
    expect(NEW_MIGRATION_VERSION > BASELINE_VERSION).toBe(true);
  });
});

describe('PROMPT.md body', () => {
  it('is the designed prompt, word for word', () => {
    expect(body.trim()).toBe(PROMPT);
  });

  it.each(BANNED_WORDS)('does not contain the word %s', (word) => {
    expect(body).not.toMatch(new RegExp(`\\b${word}\\b`, 'i'));
  });

  it.each(BANNED_STEMS)('does not contain a word starting with %s', (stem) => {
    expect(body).not.toMatch(new RegExp(`\\b${stem}\\w*`, 'i'));
  });

  it.each(BANNED_FRAGMENTS)('does not contain %s', (fragment) => {
    expect(body.toLowerCase()).not.toContain(fragment);
  });

  it.each(KEPT_WORDS)('keeps the user words "%s"', (words) => {
    expect(body.toLowerCase()).toContain(words);
  });

  it('is short and casual', () => {
    expect(body.trim().split(/\s+/).length).toBeLessThan(60);
  });
});

describe('PROMPT.md frontmatter', () => {
  it('declares a deploy-stage CLI journey that needs neither Docker nor a running project', () => {
    expect(frontmatter).toMatch(/^stage: deploy$/m);
    expect(frontmatter).toMatch(/^interface: cli$/m);
    expect(frontmatter).toMatch(/^needsDocker: false$/m);
    expect(frontmatter).toMatch(/^projectRunning: false$/m);
  });

  it('files the journey under database migrations, branching and the deploy phase', () => {
    expect(frontmatter).toMatch(/^product:\s*\n\s*- database\s*$/m);
    expect(frontmatter).toMatch(/^topic:\s*\n\s*- migrations\s*$/m);
    expect(frontmatter).toMatch(/^area: branching$/m);
    expect(frontmatter).toMatch(/^journeyPhase: deploy$/m);
  });

  it('leaves hostedProject and services unset so every CLI experiment runs it', () => {
    expect(frontmatter).not.toMatch(/^hostedProject:/m);
    expect(frontmatter).not.toMatch(/^services:/m);
  });

  it('starts the motivation with the ticket the eval implements', () => {
    expect(frontmatter).toMatch(
      /^motivation: CLI-2709, https:\/\/linear\.app\/supabase\/issue\/CLI-2709\//m
    );
  });

  it('cites the tickets and issue the scenario comes from', () => {
    const motivation = /^motivation:(.*)$/m.exec(frontmatter)?.[1] ?? '';
    for (const cited of [
      'FDBKIN-15580',
      'https://linear.app/supabase/issue/FDBKIN-15580',
      'FDBKIN-26777',
      'https://linear.app/supabase/issue/FDBKIN-26777',
      'supabase/cli#3088',
      'https://github.com/supabase/cli/issues/3088',
    ]) {
      expect(motivation).toContain(cited);
    }
  });
});

describe('local seed', () => {
  it('holds exactly the baseline and the new migration', () => {
    expect(
      readdirSync(
        new URL('./local/supabase/migrations/', import.meta.url)
      ).sort()
    ).toEqual([BASELINE_FILE, NEW_MIGRATION_FILE].sort());
  });

  it('creates orders in the baseline and shipments in the new migration, one table each', () => {
    expect(
      migrationCreatesTable(migration(BASELINE_FILE), BASELINE_TABLE)
    ).toBe(true);
    expect(migrationCreatesTable(migration(BASELINE_FILE), NEW_TABLE)).toBe(
      false
    );
    expect(
      migrationCreatesTable(migration(NEW_MIGRATION_FILE), NEW_TABLE)
    ).toBe(true);
    expect(
      migrationCreatesTable(migration(NEW_MIGRATION_FILE), BASELINE_TABLE)
    ).toBe(false);
  });

  it('carries the designed baseline SQL', () => {
    expect(migrationSql(BASELINE_FILE)).toBe(normalise(CREATE_ORDERS));
  });

  it('makes shipments reference orders and keeps a tracking number unique per carrier', () => {
    const sql = migrationSql(NEW_MIGRATION_FILE);
    expect(sql).toContain('references public.orders(id)');
    expect(sql).toContain('unique(carrier,tracking_number)');
  });

  it('configures an orders-app project with no ports', () => {
    const config = read('local/supabase/config.toml');
    expect(config).toMatch(/^project_id\s*=\s*"orders-app"\s*$/m);
    expect(config).not.toMatch(/port\s*=/i);
  });
});

describe('remote seed', () => {
  const raw = read('remote/project.sql');
  const project = stripSqlComments(raw);

  it('creates the orders table the baseline migration creates', () => {
    expect(migrationCreatesTable(project, BASELINE_TABLE)).toBe(true);
    expect(normalise(project)).toContain(normalise(CREATE_ORDERS));
  });

  it('seeds the orders rows the scorer expects', () => {
    expect(project).toMatch(/insert\s+into\s+public\.orders/i);
    const bounds = [
      ...project.matchAll(/generate_series\(\s*1\s*,\s*(\d+)\s*\)/gi),
    ].map((match) => Number(match[1]));
    expect(bounds).toEqual([SEEDED_ORDERS]);
  });

  it('declares the migration history table the CLI reads', () => {
    expect(project).toMatch(
      /create table (?:if not exists )?supabase_migrations\.schema_migrations\s*\(/i
    );
    expect(project).toMatch(/version\s+text\s+not null\s+primary key/i);
    expect(project).toMatch(/statements\s+text\[\]/i);
  });

  it('records only the baseline version in the history', () => {
    expect(
      [...project.matchAll(/'(\d{14})'/g)].map((match) => match[1])
    ).toEqual([BASELINE_VERSION]);
  });

  it('names the history row after the baseline migration and holds its SQL', () => {
    expect(project).toMatch(/'create_orders'/);
    const statement = (
      /array\s*\[\s*'((?:[^']|'')*)'\s*\]/i.exec(project)?.[1] ??
      /array\s*\[\s*\$\$([\s\S]*?)\$\$\s*\]/i.exec(project)?.[1]
    )?.replaceAll("''", "'");
    expect(statement).toBeDefined();
    expect(normalise(statement ?? '')).toBe(migrationSql(BASELINE_FILE));
  });

  it('never mentions the new migration or its table', () => {
    expect(raw).not.toContain(NEW_MIGRATION_VERSION);
    expect(raw).not.toContain(NEW_MIGRATION_FILE);
    expect(raw.toLowerCase()).not.toContain(NEW_TABLE);
  });
});
