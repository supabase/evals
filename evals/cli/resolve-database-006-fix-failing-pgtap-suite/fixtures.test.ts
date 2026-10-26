// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-006-fix-failing-pgtap-suite
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stripSqlComments } from '../lib/migrations.js';
import {
  MIGRATIONS_DIR,
  readSeedFile,
  REPLAY_DATABASE,
  SEEDED_MIGRATIONS,
  SEEDED_TEST_FILES,
  SEEDED_TESTS,
  TESTS_DIR,
} from './fixtures.js';

const evalUrl = (path: string) => new URL(`./${path}`, import.meta.url);
const read = (path: string) => readFileSync(evalUrl(path), 'utf8');

const CREATE_INVOICES = '20260101000000_create_invoices.sql';
const LINE_DISCOUNTS = '20260301000000_line_discounts.sql';
const migration = (file: string) => read(`local/supabase/migrations/${file}`);
const testFile = (file: string) => read(`local/supabase/tests/${file}`);

const BANNED_PROMPT_WORDS = [
  'supabase',
  'pgtap',
  'pg_prove',
  'test db',
  'reset',
  'migration',
  'migrations',
  'psql',
  'docker',
  'stack',
  'sql',
  'schema',
  'default',
  'null',
  'discount_percent',
  'invoice_lines',
  'invoice_total_cents',
  'function',
  'column',
  'start',
  'cli',
];

const REQUIRED_PROMPT_WORDS = [
  'discounts',
  'database tests',
  'passing',
  'running',
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

function listOf(frontmatter: string, key: string): string[] {
  const block = frontmatter.match(
    new RegExp(`^${key}:\\r?\\n((?:[ \\t]+-[^\\n]*\\n?)+)`, 'm')
  );
  return (block?.[1] ?? '')
    .split('\n')
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter((line) => line.length > 0);
}

describe('PROMPT.md frontmatter', () => {
  it('declares a resolve-stage CLI eval for database tests and migrations that needs neither a running project nor docker', () => {
    const { frontmatter } = promptParts();
    expect(frontmatter).toMatch(/^stage: resolve$/m);
    expect(frontmatter).toMatch(/^interface: cli$/m);
    expect(listOf(frontmatter, 'product')).toEqual(['database']);
    expect(listOf(frontmatter, 'topic')).toEqual(['tests', 'migrations']);
    expect(frontmatter).toMatch(/^projectRunning: false$/m);
    expect(frontmatter).toMatch(/^needsDocker: false$/m);
  });

  it('links CLI-2733 as its motivation', () => {
    expect(promptParts().frontmatter).toMatch(
      /^motivation: CLI-2733, https:\/\/linear\.app\/supabase\/issue\/CLI-2733\//m
    );
  });

  it('sits in the tests-and-lint area and the resolve journey phase', () => {
    const { frontmatter } = promptParts();
    expect(frontmatter).toMatch(/^area: tests-and-lint$/m);
    expect(frontmatter).toMatch(/^journeyPhase: resolve$/m);
  });
});

describe('PROMPT.md body', () => {
  it.each(BANNED_PROMPT_WORDS)(
    'does not give the agent the word "%s"',
    (word) => {
      expect(promptParts().body).not.toMatch(wholeWord(word));
    }
  );

  it.each(REQUIRED_PROMPT_WORDS)('mentions "%s"', (word) => {
    expect(promptParts().body).toMatch(wholeWord(word));
  });
});

describe('the whole-word guard', () => {
  it.each([
    ['run reset now', true],
    ['Reset.', true],
    ['(reset)', true],
    ['db reset', true],
    ['resets', false],
    ['reset_all', false],
    ['pre-reset', false],
    ['reset-all', false],
    ['reset2', false],
  ])('matching "reset" in %j is %s', (text, expected) => {
    expect(wholeWord('reset').test(text)).toBe(expected);
  });

  it('matches a multi-word phrase as a whole', () => {
    expect(wholeWord('test db').test('then supabase test db again')).toBe(true);
    expect(wholeWord('test db').test('the database tests fail')).toBe(false);
  });
});

describe('seeded file lists', () => {
  it('names the two seeded migrations in version order', () => {
    expect(SEEDED_MIGRATIONS).toEqual([CREATE_INVOICES, LINE_DISCOUNTS]);
  });

  it('names the two seeded test files', () => {
    expect(SEEDED_TEST_FILES).toEqual([
      'invoice_totals.test.sql',
      'line_discounts.test.sql',
    ]);
  });

  it('lists every migration the project ships', () => {
    expect(readdirSync(evalUrl('local/supabase/migrations/')).sort()).toEqual([
      ...SEEDED_MIGRATIONS,
    ]);
  });

  it('lists every test file the project ships', () => {
    expect(readdirSync(evalUrl('local/supabase/tests/')).sort()).toEqual([
      ...SEEDED_TEST_FILES,
    ]);
  });

  it('ships no seed.sql, so a reset leaves the tables empty', () => {
    expect(existsSync(evalUrl('local/supabase/seed.sql'))).toBe(false);
    expect(read('local/supabase/config.toml')).not.toMatch(/\[db\.seed\]/);
  });

  it('names the migrations directory, the tests directory and the scratch database', () => {
    expect(MIGRATIONS_DIR).toBe('supabase/migrations');
    expect(TESTS_DIR).toBe('supabase/tests');
    expect(REPLAY_DATABASE).toBe('eval_replay');
  });
});

describe('SEEDED_TESTS', () => {
  it('holds the pristine contents of each seeded test file, in file order', () => {
    expect(SEEDED_TESTS).toEqual(
      SEEDED_TEST_FILES.map((file) => ({ file, sql: testFile(file) }))
    );
  });
});

describe('readSeedFile', () => {
  it.each([
    'supabase/config.toml',
    `supabase/migrations/${CREATE_INVOICES}`,
    `supabase/migrations/${LINE_DISCOUNTS}`,
    'supabase/tests/invoice_totals.test.sql',
    'supabase/tests/line_discounts.test.sql',
  ])('returns the contents of local/%s', (path) => {
    expect(readSeedFile(path)).toBe(read(`local/${path}`));
  });

  it('throws when the file is not part of the seed', () => {
    expect(() => readSeedFile('supabase/seed.sql')).toThrow(/ENOENT/);
  });
});

describe('seeded project config', () => {
  it('names the project, pins Postgres 17 and keeps migrations enabled', () => {
    const config = read('local/supabase/config.toml');
    expect(config).toMatch(/^project_id = "invoices-app"$/m);
    expect(config).toMatch(/^major_version = 17$/m);
    expect(config).toMatch(/\[db\.migrations\]\s+enabled = true/);
  });
});

describe('the first migration', () => {
  const sql = () => stripSqlComments(migration(CREATE_INVOICES));

  it('creates invoices and invoice_lines with positive quantities and non-negative prices', () => {
    expect(sql()).toMatch(/create table public\.invoices\b/);
    expect(sql()).toMatch(/create table public\.invoice_lines\b/);
    expect(sql()).toMatch(/quantity integer not null check \(quantity > 0\)/);
    expect(sql()).toMatch(
      /unit_price_cents integer not null check \(unit_price_cents >= 0\)/
    );
  });

  it('defines invoice_total_cents as the sum of quantity times unit price, with no discount', () => {
    expect(sql()).toMatch(
      /create function public\.invoice_total_cents\(p_invoice_id bigint\)/
    );
    expect(sql()).toMatch(/sum\(l\.quantity \* l\.unit_price_cents\)/);
    expect(sql()).not.toMatch(/discount/i);
  });
});

describe('the line_discounts migration plants exactly two bugs', () => {
  const sql = () => stripSqlComments(migration(LINE_DISCOUNTS));

  it('says the discount is optional, which the column definition contradicts', () => {
    expect(migration(LINE_DISCOUNTS)).toMatch(/^-- Optional discount/m);
  });

  it('adds discount_percent as not null with no default, so an insert that omits it fails', () => {
    const add = sql().match(/add\s+column\s+discount_percent\b[^;]*/i)?.[0];
    expect(add).toBeDefined();
    expect(add).toMatch(/\bnot\s+null\b/i);
    expect(add).not.toMatch(/\bdefault\b/i);
  });

  it('keeps the 0 to 100 check on discount_percent', () => {
    expect(sql()).toMatch(/check \(discount_percent between 0 and 100\)/);
  });

  it('recomputes invoice_total_cents from the discount amount, discount_percent / 100, not what is left', () => {
    const fn = sql().match(
      /create or replace function public\.invoice_total_cents[\s\S]*?\$\$;/i
    )?.[0];
    expect(fn).toBeDefined();
    expect(fn).toMatch(
      /l\.quantity \* l\.unit_price_cents \* l\.discount_percent \/ 100/
    );
    expect(fn).not.toMatch(/100\s*-/);
  });

  it('touches nothing else', () => {
    const statements = (
      sql().match(/^(?:alter|create|drop|insert|update|delete)\b/gim) ?? []
    ).map((keyword) => keyword.toLowerCase());
    expect(statements).toEqual(['alter', 'create']);
  });
});

describe('the seeded pgTAP tests', () => {
  const ASSERTION = /^select (?:has_\w+|is|isnt|ok|throws_ok|lives_ok)\(/gm;
  const plan = (sql: string) => Number(sql.match(/select plan\((\d+)\)/)?.[1]);
  const assertions = (sql: string) => [...sql.matchAll(ASSERTION)].length;

  it.each([
    ['invoice_totals.test.sql', 4],
    ['line_discounts.test.sql', 5],
  ])(
    '%s plans %i tests, and runs exactly that many assertions',
    (file, planned) => {
      const sql = testFile(file);
      expect(plan(sql)).toBe(planned);
      expect(assertions(sql)).toBe(planned);
    }
  );

  it.each(SEEDED_TEST_FILES)(
    '%s runs in a transaction it rolls back',
    (file) => {
      const sql = testFile(file);
      expect(sql).toMatch(/^begin;/m);
      expect(sql).toMatch(/^select \* from finish\(\);\nrollback;\s*$/m);
    }
  );

  it('keeps invoice_totals from knowing about discounts, as it predates them', () => {
    const sql = testFile('invoice_totals.test.sql');
    expect(sql).not.toMatch(/discount/i);
    expect(sql).toMatch(
      /insert into public\.invoice_lines \(invoice_id, description, quantity, unit_price_cents\) values/
    );
  });

  it('has line_discounts give every line an explicit discount_percent', () => {
    const sql = testFile('line_discounts.test.sql');
    expect(sql).toMatch(
      /insert into public\.invoice_lines \(invoice_id, description, quantity, unit_price_cents, discount_percent\) values/
    );
    expect(sql).not.toMatch(
      /insert into public\.invoice_lines \(invoice_id, description, quantity, unit_price_cents\) values/
    );
  });

  it('expects the discounted totals the fixed function gives, not the buggy ones', () => {
    const sql = testFile('line_discounts.test.sql');
    expect(sql).toMatch(/(?<!\d)2700::bigint/);
    expect(sql).toMatch(/(?<!\d)4000::bigint/);
    expect(sql).toMatch(/(?<!\d)0::bigint/);
    expect(sql).not.toMatch(/(?<!\d)300::bigint/);
    expect(sql).not.toMatch(/(?<!\d)1000::bigint/);
    expect(sql).not.toMatch(/(?<!\d)2100::bigint/);
  });

  it('expects invoice_totals to see plain quantity times price', () => {
    expect(testFile('invoice_totals.test.sql')).toContain('5500::bigint');
  });
});
