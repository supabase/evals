// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-002-rls-policy-tests
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import {
  maskSqlLiteralsAndComments,
  migrationCreatesTable,
} from '../lib/migrations.js';
import {
  LEAKY_POLICY_NAME,
  NOTES_TABLE,
  PROBE_TITLE_PREFIX,
  PROBE_USERS,
  SEEDED_MIGRATION_FILE,
  SEEDED_MIGRATION_VERSION,
  SEEDED_NOTES_POLICIES,
  TESTS_DIR,
} from './fixtures.js';

const evalUrl = (path: string) => new URL(`./${path}`, import.meta.url);
const read = (path: string) => readFileSync(evalUrl(path), 'utf8');
const seededSql = () =>
  read(`local/supabase/migrations/${SEEDED_MIGRATION_FILE}`);

const FORBIDDEN_PROMPT_WORDS = [
  'supabase',
  'pgtap',
  'test db',
  'policy',
  'policies',
  'rls',
  'row level security',
  'row-level security',
  'migration',
  'auth',
  'authenticated',
  'supabase/tests',
  'public.notes',
  'owner_id',
  'title',
  'body',
  'created_at',
  'docker',
];

function promptParts() {
  const match = read('PROMPT.md').match(
    /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/
  );
  if (!match) throw new Error('PROMPT.md has no frontmatter');
  return { frontmatter: match[1], body: match[2] };
}

describe('fixture constants', () => {
  it('name the seeded migration by its version', () => {
    expect(SEEDED_MIGRATION_VERSION).toBe('20260101000000');
    expect(SEEDED_MIGRATION_FILE).toBe(
      `${SEEDED_MIGRATION_VERSION}_create_notes.sql`
    );
  });

  it('name the table, the leaky policy and the tests directory', () => {
    expect(NOTES_TABLE).toBe('notes');
    expect(LEAKY_POLICY_NAME).toBe(
      'Enable read access for authenticated users'
    );
    expect(TESTS_DIR).toBe('supabase/tests');
  });

  it('give the probe two distinct users with fixed ids and emails', () => {
    expect(PROBE_TITLE_PREFIX).toBe('eval-probe-');
    expect(PROBE_USERS).toEqual({
      owner: {
        id: 'e7a1c0de-0000-4000-8000-00000000000a',
        email: 'eval-probe-owner@example.test',
      },
      other: {
        id: 'e7a1c0de-0000-4000-8000-00000000000b',
        email: 'eval-probe-other@example.test',
      },
    });
  });
});

describe('seeded migration', () => {
  it('is the only migration the project ships', () => {
    expect(readdirSync(evalUrl('local/supabase/migrations/'))).toEqual([
      SEEDED_MIGRATION_FILE,
    ]);
  });

  it('creates public.notes owned by auth.uid()', () => {
    const sql = seededSql();
    expect(migrationCreatesTable(sql, NOTES_TABLE)).toBe(true);
    expect(sql).toMatch(/owner_id uuid not null default auth\.uid\(\)/);
  });

  it('enables row level security on public.notes', () => {
    expect(maskSqlLiteralsAndComments(seededSql())).toMatch(
      /alter\s+table\s+public\.notes\s+enable\s+row\s+level\s+security/i
    );
  });

  it('is the source of SEEDED_NOTES_POLICIES: its create policy statements on public.notes, in order, verbatim', () => {
    const statements = [
      ...seededSql().matchAll(/create policy[^;]*(?=;)/gi),
    ].map(([statement]) => statement);
    expect(statements.length).toBeGreaterThan(0);
    expect(SEEDED_NOTES_POLICIES).toEqual(statements);
  });

  it('creates every policy on public.notes and nothing else', () => {
    expect(SEEDED_NOTES_POLICIES).toHaveLength(5);
    for (const statement of SEEDED_NOTES_POLICIES) {
      expect(statement).toMatch(
        /^create policy\s+"[^"]+"\s+on public\.notes\b/
      );
      expect(statement).not.toMatch(/;/);
    }
  });
});

describe('the seeded leak', () => {
  const leaky = () =>
    SEEDED_NOTES_POLICIES.filter((statement) =>
      statement.includes(`"${LEAKY_POLICY_NAME}"`)
    );

  it('is one select policy for authenticated that uses (true)', () => {
    expect(leaky()).toHaveLength(1);
    const [policy] = leaky();
    expect(policy).toMatch(/\bfor select\b/);
    expect(policy).toMatch(/\bto authenticated\b/);
    expect(policy).toMatch(/\busing \(true\)/);
  });

  it('is the only policy that does not compare owner_id with auth.uid()', () => {
    const others = SEEDED_NOTES_POLICIES.filter(
      (statement) => !leaky().includes(statement)
    );
    expect(others).toHaveLength(4);
    for (const statement of others) {
      expect(statement).toMatch(/auth\.uid\(\)\) = owner_id/);
    }
  });

  it('leaves the write policies owner-only', () => {
    const writes = SEEDED_NOTES_POLICIES.filter((statement) =>
      /\bfor (insert|update|delete)\b/.test(statement)
    );
    expect(writes).toHaveLength(3);
    for (const statement of writes) {
      expect(statement).not.toMatch(/\b(using|with check) \(true\)/);
    }
  });
});

describe('seeded project', () => {
  it('names the project notes-app', () => {
    const config = parseToml(read('local/supabase/config.toml'));
    expect(config.project_id).toBe('notes-app');
  });

  it.each(['local/supabase/tests', 'local/supabase/seed.sql', 'local/src'])(
    'ships no %s, so the agent has to write the tests itself',
    (path) => {
      expect(existsSync(evalUrl(path))).toBe(false);
    }
  );
});

describe('PROMPT.md', () => {
  it.each(FORBIDDEN_PROMPT_WORDS)(
    'does not give the agent the word "%s"',
    (word) => {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(promptParts().body).not.toMatch(
        new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, 'i')
      );
    }
  );

  it('asks about the notes in the words of the user', () => {
    expect(promptParts().body).toMatch(/\bnotes\b/i);
  });

  it('asks the agent to leave everything running', () => {
    expect(promptParts().body).toMatch(/leave everything running/i);
  });

  it('declares a CLI investigate eval that starts without a running project or docker', () => {
    const { frontmatter } = promptParts();
    expect(frontmatter).toMatch(/^stage: investigate$/m);
    expect(frontmatter).toMatch(/^interface: cli$/m);
    expect(frontmatter).toMatch(/^projectRunning: false$/m);
    expect(frontmatter).toMatch(/^needsDocker: false$/m);
  });

  it('cites its motivation', () => {
    expect(promptParts().frontmatter).toMatch(
      /^motivation: CLI-2710, https:\/\/linear\.app\//m
    );
  });
});
