// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/build-database-005-apply-schema-change
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { migrationCreatesTable } from '../lib/migrations.js';
import {
  DUE_DATE_COLUMN,
  SEEDED_MIGRATION_FILE,
  SEEDED_MIGRATION_SHA256,
  SEEDED_MIGRATION_VERSION,
  TASKS_TABLE,
} from './fixtures.js';
import { migrationAddsColumn } from './migrations.js';

const evalUrl = (path: string) => new URL(`./${path}`, import.meta.url);
const read = (path: string) => readFileSync(evalUrl(path), 'utf8');
const seededMigrationPath = `local/supabase/migrations/${SEEDED_MIGRATION_FILE}`;

const FORBIDDEN_PROMPT_WORDS = [
  'supabase',
  'migration',
  'column',
  'due_date',
  'alter',
  'psql',
  'docker',
  'reset',
  'stack',
  'table',
  'sql',
];

function promptParts() {
  const match = read('PROMPT.md').match(
    /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/
  );
  if (!match) throw new Error('PROMPT.md has no frontmatter');
  return { frontmatter: match[1], body: match[2] };
}

describe('fixture constants', () => {
  it('carry the seeded migration checksum as a sha256 hex digest', () => {
    expect(SEEDED_MIGRATION_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('name the seeded migration by its version', () => {
    expect(SEEDED_MIGRATION_FILE).toBe(
      `${SEEDED_MIGRATION_VERSION}_create_tasks.sql`
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

  it('creates public.tasks without adding due_date', () => {
    const sql = read(seededMigrationPath);
    expect(migrationCreatesTable(sql, TASKS_TABLE)).toBe(true);
    expect(migrationAddsColumn(sql, TASKS_TABLE, DUE_DATE_COLUMN)).toBe(false);
    expect(sql).not.toContain(DUE_DATE_COLUMN);
  });

  it('is the only migration the project ships', () => {
    expect(readdirSync(evalUrl('local/supabase/migrations/'))).toEqual([
      SEEDED_MIGRATION_FILE,
    ]);
  });
});

describe('seeded app code', () => {
  it('selects and orders by due_date on the tasks table', () => {
    const code = read('local/src/tasks.ts');
    expect(code).toContain(`.from('${TASKS_TABLE}')`);
    expect(code).toMatch(
      new RegExp(`\\.select\\('[^']*\\b${DUE_DATE_COLUMN}\\b[^']*'\\)`)
    );
    expect(code).toMatch(new RegExp(`\\.order\\('${DUE_DATE_COLUMN}'`));
  });

  it('writes null to due_date, so the column has to be nullable', () => {
    const code = read('local/src/tasks.ts');
    expect(code).toMatch(
      new RegExp(`\\.update\\(\\{\\s*${DUE_DATE_COLUMN}:\\s*null\\s*\\}\\)`)
    );
    expect(code).toMatch(new RegExp(`${DUE_DATE_COLUMN}:\\s*string \\| null`));
  });
});

describe('seeded data', () => {
  it('inserts tasks without naming due_date, so existing rows predate the column', () => {
    const seed = read('local/supabase/seed.sql');
    expect(seed).toMatch(/insert into public\.tasks/i);
    expect(seed).not.toContain(DUE_DATE_COLUMN);
  });

  it('is loaded from seed.sql by config.toml', () => {
    const config = read('local/supabase/config.toml');
    expect(config).toMatch(/^project_id = "tasks-app"$/m);
    expect(config).toMatch(/\[db\.seed\]\s+enabled = true/);
    expect(config).toContain('sql_paths = ["./seed.sql"]');
  });
});

describe('seeded project layout', () => {
  it.each(['local/package.json', 'local/.env', 'local/supabase/schemas'])(
    'ships no %s, so nothing steers the agent to a package runner or a declarative schema',
    (path) => {
      expect(existsSync(evalUrl(path))).toBe(false);
    }
  );
});

describe('PROMPT.md', () => {
  it.each(FORBIDDEN_PROMPT_WORDS)(
    'does not give the agent the word "%s"',
    (word) => {
      expect(promptParts().body.toLowerCase()).not.toContain(word);
    }
  );

  it('asks for due dates on tasks in the local database', () => {
    const { body } = promptParts();
    expect(body).toMatch(/due dates?/i);
    expect(body).toMatch(/local/i);
  });

  it('declares a CLI eval that starts without a running project or docker', () => {
    const { frontmatter } = promptParts();
    expect(frontmatter).toMatch(/^interface: cli$/m);
    expect(frontmatter).toMatch(/^projectRunning: false$/m);
    expect(frontmatter).toMatch(/^needsDocker: false$/m);
  });
});
