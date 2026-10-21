// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-004-reconcile-migration-history
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stripSqlComments } from '../lib/migrations.js';
import { migrationChanges } from './changes.js';
import {
  SEEDED_LOCAL_FILES,
  SEEDED_POSTS,
  SEEDED_PROFILES,
  SEEDED_REMOTE_VERSIONS,
} from './seed.js';

const read = (path: string) =>
  readFileSync(new URL(`./${path}`, import.meta.url), 'utf8');

const normalise = (sql: string) =>
  sql
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),;])\s*/g, '$1')
    .trim()
    .replace(/;$/, '');

const CREATE_PROFILES =
  'create table public.profiles (id uuid primary key default gen_random_uuid(), username text not null unique, created_at timestamptz not null default now())';
const ADD_BIO = 'alter table public.profiles add column bio text';
const ADD_AVATAR = 'alter table public.profiles add column avatar_url text';

const localFile = (name: string) => read(`local/supabase/migrations/${name}`);

const project = stripSqlComments(read('remote/project.sql'));

function historyRow(version: string) {
  const start = project.indexOf(`'${version}'`);
  const rest = project.slice(start + version.length + 2);
  const next = rest.search(/'\d{14}'/);
  const row = next === -1 ? rest : rest.slice(0, next);
  const array =
    /array\s*\[\s*'((?:[^']|'')*)'\s*\]/i.exec(row) ??
    /array\s*\[\s*\$\$([\s\S]*?)\$\$\s*\]/i.exec(row);
  return {
    name: /'([a-z_]+)'/.exec(row)?.[1],
    statement: array?.[1].replaceAll("''", "'"),
  };
}

describe('seed constants', () => {
  it('describe the seeded divergence', () => {
    expect(SEEDED_PROFILES).toBe(25);
    expect(SEEDED_POSTS).toBe(40);
    expect([...SEEDED_REMOTE_VERSIONS]).toEqual([
      '20240101000000',
      '20240115093000',
      '20240201000000',
    ]);
    expect([...SEEDED_LOCAL_FILES]).toEqual([
      '20240101000000_create_profiles.sql',
      '20240116120000_add_profile_bio.sql',
      '20240301000000_add_profile_avatar.sql',
    ]);
  });
});

describe('local seed', () => {
  it('holds exactly the seeded migration files', () => {
    expect(
      readdirSync(
        new URL('./local/supabase/migrations/', import.meta.url)
      ).sort()
    ).toEqual([...SEEDED_LOCAL_FILES]);
  });

  it('makes profiles, bio and avatar one file each', () => {
    expect(
      migrationChanges(localFile('20240101000000_create_profiles.sql'))
    ).toEqual(['profiles']);
    expect(
      migrationChanges(localFile('20240116120000_add_profile_bio.sql'))
    ).toEqual(['bio']);
    expect(
      migrationChanges(localFile('20240301000000_add_profile_avatar.sql'))
    ).toEqual(['avatar']);
  });

  it('carries the designed SQL', () => {
    expect(normalise(localFile('20240101000000_create_profiles.sql'))).toBe(
      normalise(CREATE_PROFILES)
    );
    expect(normalise(localFile('20240116120000_add_profile_bio.sql'))).toBe(
      normalise(ADD_BIO)
    );
    expect(normalise(localFile('20240301000000_add_profile_avatar.sql'))).toBe(
      normalise(ADD_AVATAR)
    );
  });

  it('has no comments explaining the drift', () => {
    for (const file of SEEDED_LOCAL_FILES) {
      expect(localFile(file)).not.toMatch(/--|\/\*/);
    }
  });

  it('configures a Postgres 17 project with migrations on and no ports', () => {
    const config = read('local/supabase/config.toml');
    expect(config).toMatch(/^project_id\s*=\s*"profiles-app"\s*$/m);
    expect(config).toMatch(/^\[db\]\s*$/m);
    expect(config).toMatch(/^major_version\s*=\s*17\s*$/m);
    expect(config).toMatch(/^\[db\.migrations\]\s*$/m);
    expect(config).toMatch(/^enabled\s*=\s*true\s*$/m);
    expect(config).not.toMatch(/port\s*=/i);
  });
});

describe('remote seed', () => {
  it('records exactly the seeded remote versions, in order', () => {
    expect(
      [...project.matchAll(/'(\d{14})'/g)].map((match) => match[1])
    ).toEqual([...SEEDED_REMOTE_VERSIONS]);
  });

  it('names the history rows after the migrations they record', () => {
    expect(SEEDED_REMOTE_VERSIONS.map((v) => historyRow(v).name)).toEqual([
      'create_profiles',
      'add_profile_bio',
      'create_posts',
    ]);
  });

  it('holds the exact SQL of the local create-profiles migration so fetch writes the same file', () => {
    expect(normalise(historyRow('20240101000000').statement ?? '')).toBe(
      normalise(localFile('20240101000000_create_profiles.sql'))
    );
  });

  it('holds the exact SQL of the local bio migration under the earlier remote version', () => {
    expect(normalise(historyRow('20240115093000').statement ?? '')).toBe(
      normalise(localFile('20240116120000_add_profile_bio.sql'))
    );
  });

  it('holds a create-posts statement that fetch writes as a posts migration', () => {
    const { statement } = historyRow('20240201000000');
    expect(statement).toBeDefined();
    expect(migrationChanges(statement ?? '')).toEqual(['posts']);
  });

  it('replays the recorded profiles history, then creates posts, so bio is the last profiles column', () => {
    const replay = normalise(
      project.slice(0, project.search(/create schema/i))
    );
    const positions = [
      historyRow('20240101000000').statement ?? '',
      historyRow('20240115093000').statement ?? '',
      'create table public.posts',
    ].map((statement) => replay.indexOf(normalise(statement)));
    expect(positions[0]).toBeGreaterThanOrEqual(0);
    expect(positions[1]).toBeGreaterThan(positions[0]);
    expect(positions[2]).toBeGreaterThan(positions[1]);
    expect(replay.match(/create table public\.profiles/g)).toHaveLength(1);
  });

  it('creates profiles with bio and posts but no avatar_url', () => {
    expect(migrationChanges(project)).toEqual(['profiles', 'bio', 'posts']);
    expect(project).not.toContain('avatar_url');
  });

  it('declares the migration history table the CLI reads', () => {
    expect(project).toMatch(
      /create table (?:if not exists )?supabase_migrations\.schema_migrations\s*\(/i
    );
    expect(project).toMatch(/version\s+text\s+not null\s+primary key/i);
    expect(project).toMatch(/statements\s+text\[\]/i);
  });

  it('seeds the profile and post counts the scorer expects', () => {
    const bounds = [
      ...project.matchAll(/generate_series\(\s*1\s*,\s*(\d+)\s*\)/gi),
    ].map((match) => Number(match[1]));
    expect(bounds).toEqual([SEEDED_PROFILES, SEEDED_POSTS]);
  });

  it('gives every profile the bio the data check recognises', () => {
    expect(project).toMatch(/'user_'\s*\|\|/);
    expect(project).toMatch(/'Bio for user_'\s*\|\|/);
  });
});

describe('PROMPT.md', () => {
  const prompt = read('PROMPT.md');
  const [, frontmatter = '', body = ''] = prompt.split(/^---\s*$/m);

  it('names no command, flag, path, version, table or column', () => {
    expect(body.trim()).not.toBe('');
    expect(body).not.toMatch(
      /supabase|docker|psql|\bcli\b|repair|fetch|\bpush\b|\bpull\b|\bdb\b|\bprofiles?\b|\bposts?\b|avatar|\bbio\b|username|schema_migrations|\.sql|--|\d{6,}/i
    );
    expect(body.trim().split(/\s+/).length).toBeLessThan(80);
  });

  it('declares a resolve-stage CLI journey that needs neither Docker nor a running project', () => {
    expect(frontmatter).toMatch(/^stage: resolve$/m);
    expect(frontmatter).toMatch(/^interface: cli$/m);
    expect(frontmatter).toMatch(/^needsDocker: false$/m);
    expect(frontmatter).toMatch(/^projectRunning: false$/m);
    expect(frontmatter).toMatch(/^product:\s*\n\s*- database\s*$/m);
    expect(frontmatter).toMatch(/^topic:\s*\n\s*- migrations\s*$/m);
  });

  it('leaves hostedProject and services unset so every CLI experiment runs it', () => {
    expect(frontmatter).not.toMatch(/^hostedProject:/m);
    expect(frontmatter).not.toMatch(/^services:/m);
  });

  it('cites the tickets and issue the scenario comes from', () => {
    const motivation = /^motivation:(.*)$/m.exec(frontmatter)?.[1] ?? '';
    for (const cited of [
      'CLI-2702',
      'https://linear.app/supabase/issue/CLI-2702',
      'FDBKIN-8289',
      'FDBKIN-7637',
      'FDBKIN-8223',
      'supabase/cli#3493',
      'https://github.com/supabase/cli/issues/3493',
    ]) {
      expect(motivation).toContain(cited);
    }
  });
});
