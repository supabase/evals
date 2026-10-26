// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-006-fix-failing-pgtap-suite
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { shellQuote } from '../lib/shell.js';
import { readSeedFile, SEEDED_MIGRATIONS } from './fixtures.js';
import {
  checkHistoryMatchesFiles,
  HISTORY_CHECK,
  type HistoryProbe,
  type HistoryRow,
  readMigrationHistory,
} from './history.js';
import type { MigrationFile } from './workspace.js';

const DB_URL = 'postgresql://postgres:hunter2@127.0.0.1:54322/postgres';

const result = (
  stdout: string,
  ok = true,
  stderr = '',
  exitCode = ok ? 0 : 1
): CommandResult => ({ ok, exitCode, stdout, stderr });

const replaceOnce = (text: string, from: string, to: string) => {
  if (!text.includes(from)) throw new Error(`seed no longer contains ${from}`);
  return text.replace(from, to);
};

// Splits as the CLI records a migration: one element per statement, comments kept, no trailing semicolon.
function statementsOf(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inBody = false;
  for (let i = 0; i < sql.length; i++) {
    if (sql.startsWith('$$', i)) {
      inBody = !inBody;
      current += '$$';
      i += 1;
    } else if (sql[i] === ';' && !inBody) {
      statements.push(current);
      current = '';
    } else {
      current += sql[i];
    }
  }
  statements.push(current);
  return statements
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

const file = (name: string, sql: string): MigrationFile => ({
  name,
  version: name.slice(0, 14),
  sql,
});
const rowOf = ({ version, sql }: MigrationFile): HistoryRow => ({
  version,
  statements: statementsOf(sql),
});

const CREATE = file(
  SEEDED_MIGRATIONS[0],
  readSeedFile(`supabase/migrations/${SEEDED_MIGRATIONS[0]}`)
);
const DISCOUNTS = file(
  SEEDED_MIGRATIONS[1],
  readSeedFile(`supabase/migrations/${SEEDED_MIGRATIONS[1]}`)
);
const FIXED_DISCOUNTS = file(
  SEEDED_MIGRATIONS[1],
  replaceOnce(
    replaceOnce(
      DISCOUNTS.sql,
      'integer not null\n',
      'integer not null default 0\n'
    ),
    'l.unit_price_cents * l.discount_percent / 100',
    'l.unit_price_cents * (100 - l.discount_percent) / 100'
  )
);
const FIX = file(
  '20260302000000_fix_discounts.sql',
  'alter table public.invoice_lines alter column discount_percent set default 0;\n'
);

const probe = (...rows: HistoryRow[]): HistoryProbe => ({ ok: true, rows });

describe('readMigrationHistory', () => {
  const fakeExec = (response: CommandResult | (() => CommandResult)) => {
    const calls: string[] = [];
    const ctx: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async (command) => {
        calls.push(command);
        return typeof response === 'function' ? response() : response;
      },
    };
    return { ctx, calls };
  };

  it('reads the version and statements of every recorded migration through psql on the stack database', async () => {
    const { ctx, calls } = fakeExec(
      result(
        '[{"version":"20260101000000","statements":["create table a ()"]}, \n {"version":"20260301000000","statements":["alter table a add column b int","select 1"]}]\n'
      )
    );

    expect(await readMigrationHistory(ctx, DB_URL)).toEqual({
      ok: true,
      rows: [
        { version: '20260101000000', statements: ['create table a ()'] },
        {
          version: '20260301000000',
          statements: ['alter table a add column b int', 'select 1'],
        },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^psql /);
    expect(calls[0]).toContain(shellQuote(DB_URL));
    expect(calls[0]).toContain('supabase_migrations.schema_migrations');
    expect(calls[0]).toContain('statements');
    expect(calls[0]).toContain('ON_ERROR_STOP=1');
  });

  it('reads the pretty-printed JSON psql prints for json_agg', async () => {
    const { ctx } = fakeExec(
      result(
        '[{"version" : "20260101000000", "statements" : ["a", "b"]}, \n {"version" : "20260301000000", "statements" : null}]\n'
      )
    );

    expect(await readMigrationHistory(ctx, DB_URL)).toEqual({
      ok: true,
      rows: [
        { version: '20260101000000', statements: ['a', 'b'] },
        { version: '20260301000000', statements: null },
      ],
    });
  });

  it('reads an empty history as no rows', async () => {
    const { ctx } = fakeExec(result('[]\n'));

    expect(await readMigrationHistory(ctx, DB_URL)).toEqual({
      ok: true,
      rows: [],
    });
  });

  it('keeps statements that contain quotes, newlines and semicolons intact', async () => {
    const statements = [
      "-- it's a comment\ncreate function f() returns int as $$ select 1; $$ language sql",
    ];
    const { ctx } = fakeExec(
      result(JSON.stringify([{ version: '20260101000000', statements }]) + '\n')
    );

    expect(await readMigrationHistory(ctx, DB_URL)).toEqual({
      ok: true,
      rows: [{ version: '20260101000000', statements }],
    });
  });

  it('fails, with the reason, when the history table cannot be read', async () => {
    const { ctx } = fakeExec(
      result(
        '',
        false,
        'psql:<stdin>:1: ERROR:  relation "supabase_migrations.schema_migrations" does not exist',
        3
      )
    );

    const history = await readMigrationHistory(ctx, DB_URL);

    expect(history.ok).toBe(false);
    expect(!history.ok && history.notes).toContain(
      'could not read the migration history: exit 3'
    );
    expect(!history.ok && history.notes).toContain('does not exist');
  });

  it('fails when the database cannot be reached', async () => {
    const { ctx } = fakeExec(
      result('', false, 'psql: error: connection refused', 2)
    );

    const history = await readMigrationHistory(ctx, DB_URL);

    expect(history.ok).toBe(false);
    expect(!history.ok && history.notes).toContain(
      'could not read the migration history'
    );
    expect(!history.ok && history.notes).toContain('connection refused');
  });

  it.each([
    ['empty output', ''],
    ['output that is not JSON', 'NOTICE: something\n'],
    ['JSON that is not a list of rows', '{"version":"20260101000000"}'],
  ])('fails on %s even when psql exited zero', async (_label, stdout) => {
    const { ctx } = fakeExec(result(stdout));

    const history = await readMigrationHistory(ctx, DB_URL);

    expect(history.ok).toBe(false);
    expect(!history.ok && history.notes).toContain(
      'could not read the migration history'
    );
  });
});

describe('the CLI-recorded rows the fixtures assume', () => {
  it('has three statements for the first seeded migration and two for the second', () => {
    expect(statementsOf(CREATE.sql)).toHaveLength(3);
    expect(statementsOf(DISCOUNTS.sql)).toHaveLength(2);
  });

  it('keeps the leading comment and drops the trailing semicolon', () => {
    expect(statementsOf(FIXED_DISCOUNTS.sql)[0]).toBe(
      "-- Optional discount on a line, as a percentage off that line's amount.\nalter table public.invoice_lines\n  add column discount_percent integer not null default 0\n    check (discount_percent between 0 and 100)"
    );
  });
});

describe('checkHistoryMatchesFiles', () => {
  it('keeps the check name stable for the results dashboard', () => {
    expect(HISTORY_CHECK).toBe(
      'the migration history matches the migration files'
    );
  });

  it('passes when every file was recorded as it is now (an in-place fix applied by db reset)', () => {
    expect(
      checkHistoryMatchesFiles(
        [CREATE, FIXED_DISCOUNTS],
        probe(rowOf(CREATE), rowOf(FIXED_DISCOUNTS))
      )
    ).toEqual({
      name: HISTORY_CHECK,
      passed: true,
      notes: '2 migration files recorded as they are now',
    });
  });

  it('passes when a new fix migration was applied through the CLI beside the untouched seeded ones', () => {
    expect(
      checkHistoryMatchesFiles(
        [CREATE, DISCOUNTS, FIX],
        probe(rowOf(CREATE), rowOf(DISCOUNTS), rowOf(FIX))
      )
    ).toEqual({
      name: HISTORY_CHECK,
      passed: true,
      notes: '3 migration files recorded as they are now',
    });
  });

  it('passes whatever order the rows come back in', () => {
    expect(
      checkHistoryMatchesFiles(
        [CREATE, DISCOUNTS, FIX],
        probe(rowOf(FIX), rowOf(CREATE), rowOf(DISCOUNTS))
      ).passed
    ).toBe(true);
  });

  it('passes when the file gained comments and blank lines after it was recorded', () => {
    const edited = file(
      DISCOUNTS.name,
      `-- reviewed\n\n${DISCOUNTS.sql.replaceAll('\n', '\n\n')}\n-- end\n`
    );
    expect(
      checkHistoryMatchesFiles(
        [CREATE, edited],
        probe(rowOf(CREATE), rowOf(DISCOUNTS))
      ).passed
    ).toBe(true);
  });

  it('passes when the recorded statements lack the comments the file has', () => {
    const [comment, ...rest] = statementsOf(DISCOUNTS.sql);
    const withoutComment = comment.replace(/^--.*\n/, '');
    expect(
      checkHistoryMatchesFiles(
        [CREATE, DISCOUNTS],
        probe(rowOf(CREATE), {
          version: DISCOUNTS.version,
          statements: [withoutComment, ...rest],
        })
      ).passed
    ).toBe(true);
  });

  it('fails when the file was fixed but the history still holds the old statements, whether it was never applied or applied by hand', () => {
    expect(
      checkHistoryMatchesFiles(
        [CREATE, FIXED_DISCOUNTS],
        probe(rowOf(CREATE), rowOf(DISCOUNTS))
      )
    ).toEqual({
      name: HISTORY_CHECK,
      passed: false,
      notes: `${DISCOUNTS.name} was recorded with different statements than the file now holds`,
    });
  });

  it('fails when a new migration file has no history row', () => {
    expect(
      checkHistoryMatchesFiles(
        [CREATE, DISCOUNTS, FIX],
        probe(rowOf(CREATE), rowOf(DISCOUNTS))
      )
    ).toEqual({
      name: HISTORY_CHECK,
      passed: false,
      notes: `${FIX.name} is not in the migration history`,
    });
  });

  it('fails when the history is empty', () => {
    const result = checkHistoryMatchesFiles([CREATE, DISCOUNTS], probe());

    expect(result.passed).toBe(false);
    expect(result.notes).toContain(
      `${CREATE.name} is not in the migration history`
    );
    expect(result.notes).toContain(
      `${DISCOUNTS.name} is not in the migration history`
    );
  });

  it('matches the whole version, not a prefix of a longer one', () => {
    const result = checkHistoryMatchesFiles(
      [FIX],
      probe({ version: '202603020000001', statements: statementsOf(FIX.sql) })
    );

    expect(result.passed).toBe(false);
    expect(result.notes).toContain(
      `${FIX.name} is not in the migration history`
    );
  });

  it.each([
    ['null', null],
    ['an empty list', []],
  ])(
    'fails when the row was recorded with %s for statements',
    (_label, statements) => {
      expect(
        checkHistoryMatchesFiles(
          [CREATE, FIX],
          probe(rowOf(CREATE), { version: FIX.version, statements })
        )
      ).toEqual({
        name: HISTORY_CHECK,
        passed: false,
        notes: `${FIX.name} was recorded with no statements`,
      });
    }
  );

  it('fails when a row has no migration file (a migration that was recorded and then deleted)', () => {
    expect(
      checkHistoryMatchesFiles(
        [CREATE, DISCOUNTS],
        probe(rowOf(CREATE), rowOf(DISCOUNTS), {
          version: '20260215000000',
          statements: ['select 1'],
        })
      )
    ).toEqual({
      name: HISTORY_CHECK,
      passed: false,
      notes: '20260215000000 is recorded but has no migration file',
    });
  });

  it('lists every problem, separated by semicolons, and none for the files that match', () => {
    const result = checkHistoryMatchesFiles(
      [CREATE, FIXED_DISCOUNTS, FIX],
      probe(rowOf(CREATE), rowOf(DISCOUNTS), {
        version: '20260215000000',
        statements: ['select 1'],
      })
    );

    expect(result.passed).toBe(false);
    expect(result.notes?.split('; ').sort()).toEqual(
      [
        `${DISCOUNTS.name} was recorded with different statements than the file now holds`,
        `${FIX.name} is not in the migration history`,
        '20260215000000 is recorded but has no migration file',
      ].sort()
    );
  });

  it('fails with the probe notes when the history could not be read', () => {
    expect(
      checkHistoryMatchesFiles([CREATE, DISCOUNTS], {
        ok: false,
        notes: 'could not read the migration history: exit 3: no such table',
      })
    ).toEqual({
      name: HISTORY_CHECK,
      passed: false,
      notes: 'could not read the migration history: exit 3: no such table',
    });
  });

  it('fails when there are no migration files at all', () => {
    expect(checkHistoryMatchesFiles([], probe())).toEqual({
      name: HISTORY_CHECK,
      passed: false,
      notes: 'no migration files in supabase/migrations',
    });
  });
});
