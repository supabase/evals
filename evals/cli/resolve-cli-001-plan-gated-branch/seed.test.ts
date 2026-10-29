// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-cli-001-plan-gated-branch
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { migrationCreatesTable, stripSqlComments } from '../lib/migrations.js';
import {
  BASELINE_COLUMNS,
  BASELINE_TABLE,
  BASELINE_VERSION,
  NEW_MIGRATION_FILE,
  NEW_MIGRATION_VERSION,
  NEW_TABLE,
  SEEDED_TICKETS,
} from './seed.js';

const here = (path: string) => new URL(`./${path}`, import.meta.url);
const read = (path: string) => readFileSync(here(path), 'utf8');

const normalise = (sql: string) =>
  sql
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),;])/g, '$1')
    .replace(/([(,])\s+/g, '$1')
    .trim()
    .replace(/;$/, '');

const BASELINE_FILE = 'supabase/migrations/20260310090000_create_tickets.sql';

const CREATE_TICKETS =
  "create table public.tickets (id bigint generated always as identity primary key, subject text not null, status text not null default 'open', created_at timestamptz not null default now())";

const PROMPT =
  "We've got a new migration ready and I'd like the team to try it out on a preview branch of our project before it goes anywhere near production. Can you set that up?";

const BANNED_WORDS = [
  'supabase',
  'branches',
  'create',
  'push',
  'db',
  'plan',
  'upgrade',
  'paid',
  'pro',
  'free',
  'billing',
  'org',
  'organization',
  'entitlement',
  'gate',
  'limit',
  'link',
  'ref',
  'docker',
  'tickets',
  'ticket_tags',
  'tags',
  '20261022110000',
  'stop',
  'hand off',
];

const KEPT_WORDS = [
  'migration',
  'preview branch',
  'production',
  'try it out',
  'set that up',
];

const prompt = read('PROMPT.md');
const [, frontmatter = '', body = ''] = prompt.split(/^---\s*$/m);

const migration = (file: string) => read(`local/${file}`);

const migrationSql = (file: string) =>
  normalise(stripSqlComments(migration(file)));

const inList = (key: string, value: string) =>
  new RegExp(
    `^${key}:\\s*(?:\\[\\s*${value}\\s*\\]|\\n\\s*-\\s*${value})\\s*$`,
    'm'
  );

describe('seed constants', () => {
  it('describe the baseline already on production and the new migration', () => {
    expect(BASELINE_VERSION).toBe('20260310090000');
    expect(BASELINE_TABLE).toBe('tickets');
    expect(SEEDED_TICKETS).toBe(8);
    expect(NEW_MIGRATION_VERSION).toBe('20261022110000');
    expect(NEW_MIGRATION_FILE).toBe(
      'supabase/migrations/20261022110000_add_ticket_tags.sql'
    );
    expect(NEW_TABLE).toBe('ticket_tags');
  });

  it('name the columns of the baseline tickets table, in the order it declares them', () => {
    const declared = CREATE_TICKETS.slice(
      CREATE_TICKETS.indexOf('(') + 1,
      CREATE_TICKETS.lastIndexOf(')')
    )
      .split(', ')
      .map((definition) => definition.split(' ')[0]);
    expect(BASELINE_COLUMNS).toEqual(declared);
  });

  it('put the version at the front of each file name', () => {
    expect(BASELINE_FILE).toContain(`/${BASELINE_VERSION}_`);
    expect(NEW_MIGRATION_FILE).toContain(`/${NEW_MIGRATION_VERSION}_`);
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

  it.each(KEPT_WORDS)('keeps the user words "%s"', (words) => {
    expect(body.toLowerCase()).toContain(words);
  });
});

describe('PROMPT.md frontmatter', () => {
  it('declares a resolve-stage CLI journey that needs neither Docker nor a running project', () => {
    expect(frontmatter).toMatch(/^stage: resolve$/m);
    expect(frontmatter).toMatch(/^interface: cli$/m);
    expect(frontmatter).toMatch(/^needsDocker: false$/m);
    expect(frontmatter).toMatch(/^projectRunning: false$/m);
  });

  it('files the journey under database migrations, branching and the resolve phase', () => {
    expect(frontmatter).toMatch(inList('product', 'database'));
    expect(frontmatter).toMatch(inList('topic', 'migrations'));
    expect(frontmatter).toMatch(/^area: branching$/m);
    expect(frontmatter).toMatch(/^journeyPhase: resolve$/m);
  });

  it('leaves hostedProject and services unset so every CLI experiment runs it', () => {
    expect(frontmatter).not.toMatch(/^hostedProject:/m);
    expect(frontmatter).not.toMatch(/^services:/m);
  });

  it('starts the motivation with the ticket the eval implements', () => {
    expect(frontmatter).toMatch(
      /^motivation: CLI-2839, https:\/\/linear\.app\/supabase\/issue\/CLI-2839\//m
    );
  });

  it('cites the ticket and the CLI change the scenario comes from', () => {
    const motivation = /^motivation:(.*)$/m.exec(frontmatter)?.[1] ?? '';
    for (const cited of [
      'GROWTH-1050',
      'https://linear.app/supabase/issue/GROWTH-1050',
      'supabase/cli#7271',
    ]) {
      expect(motivation).toContain(cited);
    }
    expect(motivation).toMatch(
      /https:\/\/github\.com\/supabase\/cli\/(?:pull|issues)\/7271/
    );
  });
});

describe('local seed', () => {
  it('holds exactly the baseline and the new migration', () => {
    expect(
      readdirSync(
        new URL('./local/supabase/migrations/', import.meta.url)
      ).sort()
    ).toEqual(
      [BASELINE_FILE, NEW_MIGRATION_FILE]
        .map((file) => file.replace('supabase/migrations/', ''))
        .sort()
    );
  });

  it('creates tickets in the baseline and ticket_tags in the new migration, one table each', () => {
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
    expect(migrationSql(BASELINE_FILE)).toBe(normalise(CREATE_TICKETS));
  });

  it('makes ticket_tags reference tickets, cascade on delete and keep a tag unique per ticket', () => {
    const sql = migrationSql(NEW_MIGRATION_FILE);
    expect(sql).toContain(
      'ticket_id bigint not null references public.tickets(id) on delete cascade'
    );
    expect(sql).toContain('tag text not null');
    expect(sql).toContain('created_at timestamptz default now()');
    expect(sql).toContain('primary key(ticket_id,tag)');
  });

  it('indexes the tag column', () => {
    expect(migrationSql(NEW_MIGRATION_FILE)).toMatch(
      /create index [^;]*on public\.ticket_tags[^;]*\(tag\)/
    );
  });

  it('explains in a header comment what tags are for and that a ticket cannot carry one twice', () => {
    const header = migration(NEW_MIGRATION_FILE)
      .split('\n')
      .filter((line) => line.trimStart().startsWith('--'))
      .join('\n');
    expect(migration(NEW_MIGRATION_FILE).trimStart().startsWith('--')).toBe(
      true
    );
    expect(header).toMatch(/support agents/i);
    expect(header).toMatch(/twice/i);
  });

  it('configures a helpdesk project with no ports', () => {
    const config = read('local/supabase/config.toml');
    expect(config).toMatch(/^project_id\s*=\s*"helpdesk"\s*$/m);
    expect(config).not.toMatch(/port\s*=/i);
  });
});

describe('remote seed', () => {
  const raw = read('remote/project.sql');
  const project = stripSqlComments(raw);

  it('creates the tickets table the baseline migration creates', () => {
    expect(migrationCreatesTable(project, BASELINE_TABLE)).toBe(true);
    expect(normalise(project)).toContain(normalise(CREATE_TICKETS));
  });

  it('seeds the tickets rows the scorer expects', () => {
    expect(project).toMatch(/insert\s+into\s+public\.tickets/i);
    const bounds = [
      ...project.matchAll(/generate_series\(\s*1\s*,\s*(\d+)\s*\)/gi),
    ].map((match) => Number(match[1]));
    expect(bounds).toEqual([SEEDED_TICKETS]);
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
    expect(project).toMatch(/'create_tickets'/);
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
