// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-006-fix-failing-pgtap-suite
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { shellQuote } from '../lib/shell.js';
import { readSeedFile } from './fixtures.js';
import {
  psqlCommand,
  readPsqlError,
  sqlFingerprint,
  withDatabase,
} from './sql.js';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const CREATE_INVOICES = readSeedFile(
  'supabase/migrations/20260101000000_create_invoices.sql'
);
const LINE_DISCOUNTS = readSeedFile(
  'supabase/migrations/20260301000000_line_discounts.sql'
);

// What `supabase_migrations.schema_migrations.statements` holds for a file: one entry per statement, comments kept, no trailing `;`.
const recordedStatements = (file: string) =>
  file
    .trim()
    .split('\n\n')
    .map((statement) => statement.trim().replace(/;$/, ''));

describe('sqlFingerprint', () => {
  it('ignores line and block comments', () => {
    expect(
      sqlFingerprint(
        "-- leading\nselect 1 /* inline */ as one; -- trailing\n/* block\nspanning lines */\nselect 'x';"
      )
    ).toBe(sqlFingerprint("select 1 as one; select 'x';"));
  });

  it('ignores indentation, line breaks and runs of whitespace', () => {
    expect(
      sqlFingerprint(
        'alter table public.invoice_lines\n  add column discount_percent integer\n    not null default 0;'
      )
    ).toBe(
      sqlFingerprint(
        'alter table   public.invoice_lines add column discount_percent integer not null default 0 ;\n\n'
      )
    );
  });

  it('ignores trailing semicolons and CRLF line endings', () => {
    expect(sqlFingerprint('select 1;\r\nselect 2;\r\n')).toBe(
      sqlFingerprint('select 1\nselect 2')
    );
  });

  it('is equal for a migration file and the statements the CLI recorded for it, joined with newlines', () => {
    for (const file of [CREATE_INVOICES, LINE_DISCOUNTS]) {
      const statements = recordedStatements(file);
      expect(statements.length).toBeGreaterThan(0);
      expect(sqlFingerprint(statements.join('\n'))).toBe(sqlFingerprint(file));
    }
  });

  it('builds recorded statements that keep the leading comment on the first statement and lose the trailing semicolon', () => {
    const [first] = recordedStatements(LINE_DISCOUNTS);
    expect(first.startsWith('-- Optional discount on a line')).toBe(true);
    expect(first.endsWith(';')).toBe(false);
  });

  it('differs when a migration file gains a default', () => {
    expect(
      sqlFingerprint(
        LINE_DISCOUNTS.replace('integer not null', 'integer not null default 0')
      )
    ).not.toBe(sqlFingerprint(LINE_DISCOUNTS));
  });

  it('differs when a number changes', () => {
    expect(
      sqlFingerprint(
        LINE_DISCOUNTS.replace('between 0 and 100', 'between 0 and 101')
      )
    ).not.toBe(sqlFingerprint(LINE_DISCOUNTS));
  });

  it('differs when a keyword changes', () => {
    expect(
      sqlFingerprint(LINE_DISCOUNTS.replace('integer not null', 'integer null'))
    ).not.toBe(sqlFingerprint(LINE_DISCOUNTS));
  });

  it('differs when the function formula changes', () => {
    expect(
      sqlFingerprint(
        LINE_DISCOUNTS.replace(
          'l.discount_percent / 100',
          '(100 - l.discount_percent) / 100'
        )
      )
    ).not.toBe(sqlFingerprint(LINE_DISCOUNTS));
  });

  it('differs when a statement is added', () => {
    expect(sqlFingerprint(`${LINE_DISCOUNTS}\nselect 1;`)).not.toBe(
      sqlFingerprint(LINE_DISCOUNTS)
    );
  });

  it('keeps a -- inside a string literal instead of treating it as a comment', () => {
    expect(sqlFingerprint("select 'a -- b' as x;")).toBe("select'a--b'asx");
    expect(sqlFingerprint("select 'a -- b' as x;")).not.toBe(
      sqlFingerprint("select 'a ' as x;")
    );
  });

  it('keeps a -- inside a dollar-quoted body instead of treating it as a comment', () => {
    const withDashes =
      'create function f() returns int as $$ select 1 -- one\n$$ language sql;';
    expect(sqlFingerprint(withDashes)).toBe(
      'createfunctionf()returnsintas$$select1--one$$languagesql'
    );
    expect(sqlFingerprint(withDashes)).not.toBe(
      sqlFingerprint(
        'create function f() returns int as $$ select 1 $$ language sql;'
      )
    );
  });

  it('keeps a -- inside a tagged dollar-quoted body', () => {
    expect(sqlFingerprint('select $tag$ -- not a comment $tag$;')).toBe(
      'select$tag$--notacomment$tag$'
    );
  });
});

describe('psqlCommand', () => {
  it('runs psql against the quoted url with the quiet, unaligned, stop-on-error flags and the given arguments', () => {
    expect(psqlCommand(DB_URL, '-c "select 1"')).toBe(
      `psql '${DB_URL}' -X -A -t -q -v ON_ERROR_STOP=1 -c "select 1"`
    );
  });

  it('passes a script on stdin with -f -', () => {
    expect(psqlCommand(DB_URL, '-f -')).toBe(
      `psql '${DB_URL}' -X -A -t -q -v ON_ERROR_STOP=1 -f -`
    );
  });

  it('quotes a url whose password holds a single quote so the shell hands psql the url unchanged', () => {
    const url =
      "postgresql://postgres:p'w;echo injected;#@127.0.0.1:54322/postgres";
    const command = psqlCommand(url, '-f -');
    expect(command.startsWith(`psql ${shellQuote(url)} `)).toBe(true);
    const printed = execFileSync(
      'sh',
      ['-c', `psql() { printf '%s' "$1"; }; ${command}`],
      { encoding: 'utf8' }
    );
    expect(printed).toBe(url);
  });
});

describe('withDatabase', () => {
  it('points the url at another database', () => {
    expect(withDatabase(DB_URL, 'eval_replay')).toBe(
      'postgresql://postgres:postgres@127.0.0.1:54322/eval_replay'
    );
  });

  it('keeps the query string', () => {
    expect(withDatabase(`${DB_URL}?sslmode=disable`, 'eval_replay')).toBe(
      'postgresql://postgres:postgres@127.0.0.1:54322/eval_replay?sslmode=disable'
    );
  });

  it('keeps a password with a single quote', () => {
    expect(
      withDatabase(
        "postgresql://postgres:p'w@127.0.0.1:54322/postgres",
        'eval_replay'
      )
    ).toBe("postgresql://postgres:p'w@127.0.0.1:54322/eval_replay");
  });

  it('is a no-op when the url already names that database', () => {
    expect(withDatabase(DB_URL, 'postgres')).toBe(DB_URL);
  });
});

describe('readPsqlError', () => {
  it('reads a statement error from a script piped on stdin as file:line: message', () => {
    expect(
      readPsqlError(
        `psql:<stdin>:12: ERROR:  null value in column "discount_percent" of relation "invoice_lines" violates not-null constraint
DETAIL:  Failing row contains (1, 900001, Consulting hours, 2, 1500, null).
`
      )
    ).toBe(
      '<stdin>:12: null value in column "discount_percent" of relation "invoice_lines" violates not-null constraint'
    );
  });

  it('reads a statement error from a migration file', () => {
    expect(
      readPsqlError(
        'psql:supabase/migrations/20260401000000_dup.sql:1: ERROR:  relation "invoices" already exists\n'
      )
    ).toBe(
      'supabase/migrations/20260401000000_dup.sql:1: relation "invoices" already exists'
    );
  });

  it('reads the first error when psql printed notices before it and more errors after', () => {
    expect(
      readPsqlError(
        'psql:a.sql:3: NOTICE:  table "x" does not exist, skipping\npsql:a.sql:4: ERROR:  first\npsql:b.sql:9: ERROR:  second\n'
      )
    ).toBe('a.sql:4: first');
  });

  it('falls back to the trimmed first line of a connection error', () => {
    expect(
      readPsqlError(
        'psql: error: connection to server at "127.0.0.1", port 54322 failed: Connection refused\n\tIs the server running on that host and accepting TCP/IP connections?\n'
      )
    ).toBe(
      'psql: error: connection to server at "127.0.0.1", port 54322 failed: Connection refused'
    );
  });

  it('trims whitespace around the fallback line', () => {
    expect(readPsqlError('  psql: error: boom  \nmore\n')).toBe(
      'psql: error: boom'
    );
  });

  it('is undefined for empty stderr', () => {
    expect(readPsqlError('')).toBeUndefined();
  });

  it('is undefined for stderr that is only whitespace', () => {
    expect(readPsqlError('  \n\n')).toBeUndefined();
  });
});
