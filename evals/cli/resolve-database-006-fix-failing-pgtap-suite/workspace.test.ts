// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-006-fix-failing-pgtap-suite
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { shellQuote } from '../lib/shell.js';
import {
  readSeedFile,
  SEEDED_MIGRATIONS,
  SEEDED_TEST_FILES,
  SEEDED_TESTS,
} from './fixtures.js';
import {
  checkSeededTestsUnchanged,
  diffSeededMigrations,
  type MigrationFile,
  readWorkspace,
  TESTS_UNCHANGED_CHECK,
  type WorkspaceProbe,
} from './workspace.js';

const result = (stdout: string, ok = true, stderr = ''): CommandResult => ({
  ok,
  exitCode: ok ? 0 : 1,
  stdout,
  stderr,
});

const unquote = (text: string) =>
  text.startsWith("'") ? text.slice(1, -1).replaceAll("'\\''", "'") : text;

type Workspace = {
  listing?: string | CommandResult;
  migrations?: Record<string, string>;
  tests?: Record<string, string> | null;
  failCat?: string[];
};

// Answers by what a command asks about, so any command shape that lists, finds or reads a path gets the same state.
function fakeWorkspace({
  listing = '',
  migrations = {},
  tests = {},
  failCat = [],
}: Workspace) {
  const calls: string[] = [];
  const ctx: Pick<LocalStackEvalContext, 'exec'> = {
    exec: async (command) => {
      calls.push(command);
      if (/^ls\b/.test(command) && command.includes('supabase/migrations')) {
        return typeof listing === 'string' ? result(listing) : listing;
      }
      if (/^find\b/.test(command) && command.includes('supabase/tests')) {
        if (tests === null) {
          return {
            ok: false,
            exitCode: 1,
            stdout: '',
            stderr: "find: 'supabase/tests': No such file or directory",
          };
        }
        const relative = /-printf\s+'?%P/.test(command);
        return result(
          Object.keys(tests)
            .reverse()
            .map((name) => (relative ? name : `supabase/tests/${name}`))
            .join('\n')
        );
      }
      const cat = /^cat\s+(.+?)\s*$/.exec(command);
      if (cat) {
        const path = unquote(cat[1]);
        const migration = path.match(/^supabase\/migrations\/(.+)$/)?.[1];
        if (migration !== undefined) {
          return failCat.includes(migration) || !(migration in migrations)
            ? result('', false, `cat: ${path}: No such file or directory`)
            : result(migrations[migration]);
        }
        const testPath = path.match(/^supabase\/tests\/(.+)$/)?.[1];
        if (testPath !== undefined) {
          return tests !== null && testPath in tests
            ? result(tests[testPath])
            : result('', false, `cat: ${path}: No such file or directory`);
        }
      }
      return result('', false, `unexpected command: ${command}`);
    },
  };
  return { ctx, calls };
}

const A = '20260101000000_create_invoices.sql';
const B = '20260301000000_line_discounts.sql';
const FIX = '20260302000000_fix_discounts.sql';
const FILES = {
  [A]: 'create table a (id int);',
  [B]: 'alter table a add column x int;',
  [FIX]: 'alter table a alter column x set default 0;',
};

const SEEDED_TEST_SQL = Object.fromEntries(
  SEEDED_TESTS.map(({ file, sql }) => [file, sql])
);

const migrationFile = (name: string, sql: string): MigrationFile => ({
  name,
  version: name.slice(0, 14),
  sql,
});
const seededMigrations = () =>
  SEEDED_MIGRATIONS.map((name) =>
    migrationFile(name, readSeedFile(`supabase/migrations/${name}`))
  );

const okOf = (probe: WorkspaceProbe) => {
  if (!probe.ok) throw new Error(`workspace probe failed: ${probe.notes}`);
  return probe;
};

describe('readWorkspace', () => {
  describe('migrations', () => {
    it('reads each migration with its version, sorted by version whatever order ls lists them in', async () => {
      const { ctx } = fakeWorkspace({
        listing: `${FIX}\n${A}\n${B}\n`,
        migrations: FILES,
      });

      expect(okOf(await readWorkspace(ctx)).migrations).toEqual([
        { name: A, version: '20260101000000', sql: FILES[A] },
        { name: B, version: '20260301000000', sql: FILES[B] },
        { name: FIX, version: '20260302000000', sql: FILES[FIX] },
      ]);
    });

    it('breaks a version tie by name', async () => {
      const first = '20260302000000_a_fix.sql';
      const second = '20260302000000_b_fix.sql';
      const { ctx } = fakeWorkspace({
        listing: `${second}\n${first}\n`,
        migrations: { [first]: 'a', [second]: 'b' },
      });

      expect(
        okOf(await readWorkspace(ctx)).migrations.map(({ name }) => name)
      ).toEqual([first, second]);
    });

    it('returns each file exactly as cat printed it', async () => {
      const sql = '\n-- header\ncreate table a (id int);\n\n\n';
      const { ctx } = fakeWorkspace({ listing: A, migrations: { [A]: sql } });

      expect(okOf(await readWorkspace(ctx)).migrations[0].sql).toBe(sql);
    });

    it.each([
      'README.md',
      'notes.sql',
      '.gitkeep',
      'create_invoices.sql',
      '20260101000000.sql',
      '20260101000000_create_invoices.sql.bak',
      '20260101000000_create_invoices.SQL',
      'archive',
    ])(
      'skips %s, which is not a <version>_<name>.sql migration',
      async (name) => {
        const { ctx, calls } = fakeWorkspace({
          listing: `${A}\n${name}\n`,
          migrations: { [A]: FILES[A] },
        });

        expect(okOf(await readWorkspace(ctx)).migrations).toEqual([
          { name: A, version: '20260101000000', sql: FILES[A] },
        ]);
        expect(
          calls.filter((call) => call.includes(`supabase/migrations/${name}`))
        ).toEqual([]);
      }
    );

    it('shell-quotes the path it cats, so a file name with a quote cannot break out', async () => {
      const odd = "20260101000000_it's here.sql";
      const { ctx, calls } = fakeWorkspace({
        listing: odd,
        migrations: { [odd]: 'select 1;' },
      });

      expect(okOf(await readWorkspace(ctx)).migrations).toEqual([
        { name: odd, version: '20260101000000', sql: 'select 1;' },
      ]);
      expect(
        calls.some((call) =>
          call.includes(shellQuote(`supabase/migrations/${odd}`))
        )
      ).toBe(true);
    });

    it('reads a migration with nothing between the underscore and .sql, as the CLI does', async () => {
      const bare = '20261026000000_.sql';
      const { ctx } = fakeWorkspace({
        listing: `${A}\n${bare}\n`,
        migrations: { [A]: FILES[A], [bare]: 'select 1;' },
      });

      expect(okOf(await readWorkspace(ctx)).migrations).toEqual([
        { name: A, version: '20260101000000', sql: FILES[A] },
        { name: bare, version: '20261026000000', sql: 'select 1;' },
      ]);
    });

    it('is ok with no migrations when the directory holds no migration file', async () => {
      const { ctx } = fakeWorkspace({ listing: 'README.md\n' });

      expect(okOf(await readWorkspace(ctx)).migrations).toEqual([]);
    });

    it('is ok with no migrations when the directory is empty', async () => {
      const { ctx } = fakeWorkspace({ listing: '' });

      expect(okOf(await readWorkspace(ctx)).migrations).toEqual([]);
    });

    it('fails, naming the directory and the exit code, when the migrations directory cannot be listed', async () => {
      const { ctx } = fakeWorkspace({
        listing: {
          ok: false,
          exitCode: 2,
          stdout: '',
          stderr:
            "ls: cannot access 'supabase/migrations': No such file or directory",
        },
      });

      const probe = await readWorkspace(ctx);

      expect(probe.ok).toBe(false);
      expect(!probe.ok && probe.notes).toContain('supabase/migrations');
      expect(!probe.ok && probe.notes).toContain('exit 2');
    });

    it('fails, naming the file, when a migration cannot be read, rather than returning a partial set', async () => {
      const { ctx } = fakeWorkspace({
        listing: `${A}\n${B}\n`,
        migrations: FILES,
        failCat: [B],
      });

      const probe = await readWorkspace(ctx);

      expect(probe.ok).toBe(false);
      expect(!probe.ok && probe.notes).toContain(B);
    });
  });

  describe('seeded tests', () => {
    it('reads each seeded test file in seeded order, verbatim', async () => {
      const edited = `${SEEDED_TEST_SQL[SEEDED_TEST_FILES[1]]}\n-- mine\n`;
      const { ctx } = fakeWorkspace({
        listing: A,
        migrations: { [A]: FILES[A] },
        tests: {
          [SEEDED_TEST_FILES[1]]: edited,
          [SEEDED_TEST_FILES[0]]: SEEDED_TEST_SQL[SEEDED_TEST_FILES[0]],
        },
      });

      expect(okOf(await readWorkspace(ctx)).seededTests).toEqual([
        {
          file: SEEDED_TEST_FILES[0],
          sql: SEEDED_TEST_SQL[SEEDED_TEST_FILES[0]],
        },
        { file: SEEDED_TEST_FILES[1], sql: edited },
      ]);
    });

    it('reports a deleted seeded test file as null and leaves the other alone', async () => {
      const { ctx } = fakeWorkspace({
        listing: A,
        migrations: { [A]: FILES[A] },
        tests: {
          [SEEDED_TEST_FILES[0]]: SEEDED_TEST_SQL[SEEDED_TEST_FILES[0]],
        },
      });

      expect(okOf(await readWorkspace(ctx)).seededTests).toEqual([
        {
          file: SEEDED_TEST_FILES[0],
          sql: SEEDED_TEST_SQL[SEEDED_TEST_FILES[0]],
        },
        { file: SEEDED_TEST_FILES[1], sql: null },
      ]);
    });

    it('reports every seeded test file as null when supabase/tests is gone', async () => {
      const { ctx } = fakeWorkspace({
        listing: A,
        migrations: { [A]: FILES[A] },
        tests: null,
      });

      const probe = okOf(await readWorkspace(ctx));

      expect(probe.seededTests).toEqual(
        SEEDED_TEST_FILES.map((file) => ({ file, sql: null }))
      );
    });

    it('keeps an empty seeded test file as an empty string, not as missing', async () => {
      const { ctx } = fakeWorkspace({
        listing: A,
        migrations: { [A]: FILES[A] },
        tests: { [SEEDED_TEST_FILES[0]]: '' },
      });

      expect(okOf(await readWorkspace(ctx)).seededTests[0]).toEqual({
        file: SEEDED_TEST_FILES[0],
        sql: '',
      });
    });
  });

  describe('test files', () => {
    it('lists every test file relative to supabase/tests, sorted', async () => {
      const { ctx } = fakeWorkspace({
        listing: A,
        migrations: { [A]: FILES[A] },
        tests: {
          'line_discounts.test.sql': 'a',
          'extra/rounding.test.sql': 'b',
          'invoice_totals.test.sql': 'c',
          'zz_last.test.pg': 'd',
        },
      });

      expect(okOf(await readWorkspace(ctx)).testFiles).toEqual([
        'extra/rounding.test.sql',
        'invoice_totals.test.sql',
        'line_discounts.test.sql',
        'zz_last.test.pg',
      ]);
    });

    it('asks find for the sql and pg files under supabase/tests', async () => {
      const { ctx, calls } = fakeWorkspace({
        listing: A,
        migrations: { [A]: FILES[A] },
      });

      await readWorkspace(ctx);

      const find = calls.find((call) => /^find\b/.test(call));
      expect(find).toContain('supabase/tests');
      expect(find).toMatch(/\*\.sql/);
      expect(find).toMatch(/\*\.pg/);
    });

    it('is empty, not a failure, when supabase/tests does not exist', async () => {
      const { ctx } = fakeWorkspace({
        listing: A,
        migrations: { [A]: FILES[A] },
        tests: null,
      });

      expect(okOf(await readWorkspace(ctx)).testFiles).toEqual([]);
    });

    it('is empty when the directory holds no test files', async () => {
      const { ctx } = fakeWorkspace({
        listing: A,
        migrations: { [A]: FILES[A] },
        tests: {},
      });

      expect(okOf(await readWorkspace(ctx)).testFiles).toEqual([]);
    });
  });
});

const probeOf = (
  seededTests: Array<{ file: string; sql: string | null }> = SEEDED_TESTS.map(
    ({ file, sql }) => ({ file, sql })
  )
): WorkspaceProbe => ({
  ok: true,
  migrations: [],
  seededTests,
  testFiles: seededTests.map(({ file }) => file),
});

const withEdit = (index: number, edit: (sql: string) => string) =>
  SEEDED_TESTS.map(({ file, sql }, i) => ({
    file,
    sql: i === index ? edit(sql) : sql,
  }));

const replaceOnce = (text: string, from: string, to: string) => {
  if (!text.includes(from)) throw new Error(`seed no longer contains ${from}`);
  return text.replace(from, to);
};

describe('checkSeededTestsUnchanged', () => {
  it('names the check as the results dashboard knows it', () => {
    expect(TESTS_UNCHANGED_CHECK).toBe(
      'the seeded tests were left as they were'
    );
  });

  it('passes when both seeded test files are as seeded', () => {
    expect(checkSeededTestsUnchanged(probeOf())).toEqual({
      name: TESTS_UNCHANGED_CHECK,
      passed: true,
      notes: '2 seeded test files unchanged',
    });
  });

  it('passes when only comments and blank lines were added', () => {
    const tests = withEdit(
      0,
      (sql) => `-- checked by hand\n\n${sql}\n\n-- end\n`
    );
    expect(checkSeededTestsUnchanged(probeOf(tests)).passed).toBe(true);
  });

  it('passes when the line endings or indentation changed', () => {
    const tests = SEEDED_TESTS.map(({ file, sql }) => ({
      file,
      sql: sql.replaceAll('\n', '\r\n').replaceAll('  ', '\t'),
    }));
    expect(checkSeededTestsUnchanged(probeOf(tests)).passed).toBe(true);
  });

  it('passes when the file only gained a block comment', () => {
    const tests = withEdit(
      1,
      (sql) => `/* discounts\n   are percentages */\n${sql}`
    );
    expect(checkSeededTestsUnchanged(probeOf(tests)).passed).toBe(true);
  });

  describe('with statements added to a seeded file', () => {
    const EXTRA_ASSERTION = `insert into public.invoices (id, customer_name) values (900104, 'Default Discount Ltd');
insert into public.invoice_lines (invoice_id, description, quantity, unit_price_cents) values (900104, 'No discount given', 1, 500);
select is(public.invoice_total_cents(900104), 500::bigint, 'a line without a discount is full price');
`;
    const FIRST_IS =
      "select is(\n  public.invoice_total_cents(900101),\n  2700::bigint,\n  'a 10% discount takes 10% off the line'\n);\n\n";
    const FINISH = 'select * from finish();';

    const edited = (edit: (sql: string) => string) =>
      probeOf(withEdit(1, edit));
    const withPlan = (plan: number) => (sql: string) =>
      replaceOnce(sql, 'select plan(5)', `select plan(${plan})`);

    it('passes when an assertion was added and the plan raised to match', () => {
      const probe = edited((sql) =>
        replaceOnce(withPlan(6)(sql), FINISH, `${EXTRA_ASSERTION}\n${FINISH}`)
      );
      expect(checkSeededTestsUnchanged(probe)).toEqual({
        name: TESTS_UNCHANGED_CHECK,
        passed: true,
        notes: '2 seeded test files unchanged',
      });
    });

    it('passes when statements were added before, between and after the seeded ones', () => {
      const probe = edited((sql) =>
        replaceOnce(
          replaceOnce(
            replaceOnce(
              withPlan(8)(sql),
              'select plan',
              "select ok(true, 'first');\nselect plan"
            ),
            FIRST_IS,
            `${FIRST_IS}select ok(true, 'between');\n\n`
          ),
          FINISH,
          `select ok(true, 'last');\n${FINISH}`
        )
      );
      expect(checkSeededTestsUnchanged(probe).passed).toBe(true);
    });

    it('passes when the plan was only raised', () => {
      expect(checkSeededTestsUnchanged(edited(withPlan(9))).passed).toBe(true);
    });

    it('passes when the plan statement was reformatted', () => {
      expect(
        checkSeededTestsUnchanged(
          edited((sql) =>
            replaceOnce(sql, 'select plan(5)', 'SELECT  plan( 5 )')
          )
        ).passed
      ).toBe(true);
    });

    it('passes when an added assertion holds a semicolon inside its dollar-quoted body', () => {
      const probe = edited((sql) =>
        replaceOnce(
          withPlan(6)(sql),
          FINISH,
          `select throws_ok(\n  $$insert into public.invoices (id, customer_name) values (1, 'a'); insert into public.invoices (id, customer_name) values (1, 'b')$$,\n  '23505'\n);\n\n${FINISH}`
        )
      );
      expect(checkSeededTestsUnchanged(probe).passed).toBe(true);
    });

    it('fails when the plan was lowered and nothing was removed', () => {
      expect(checkSeededTestsUnchanged(edited(withPlan(4)))).toEqual({
        name: TESTS_UNCHANGED_CHECK,
        passed: false,
        notes: `modified: ${SEEDED_TEST_FILES[1]}`,
      });
    });

    it('fails when a seeded assertion was replaced by a different one', () => {
      const probe = edited((sql) =>
        replaceOnce(sql, FIRST_IS, "select ok(true, 'something else');\n\n")
      );
      expect(checkSeededTestsUnchanged(probe).passed).toBe(false);
    });

    it('fails when seeded assertions were reordered', () => {
      const probe = edited((sql) =>
        replaceOnce(
          replaceOnce(sql, FIRST_IS, ''),
          FINISH,
          `${FIRST_IS}${FINISH}`
        )
      );
      expect(checkSeededTestsUnchanged(probe).passed).toBe(false);
    });

    it('fails when the plan statement is gone', () => {
      const probe = edited((sql) => replaceOnce(sql, 'select plan(5);\n', ''));
      expect(checkSeededTestsUnchanged(probe).passed).toBe(false);
    });

    it('fails when the file plans twice', () => {
      const probe = edited((sql) =>
        replaceOnce(sql, FINISH, `select plan(5);\n${FINISH}`)
      );
      expect(checkSeededTestsUnchanged(probe).passed).toBe(false);
    });

    it('fails when a statement was added to a seeded dollar-quoted body', () => {
      const probe = edited((sql) =>
        replaceOnce(
          sql,
          "values (900101, 'Too generous', 1, 100, 101)$$",
          "values (900101, 'Too generous', 1, 100, 101); select 1$$"
        )
      );
      expect(checkSeededTestsUnchanged(probe).passed).toBe(false);
    });

    it('fails when keywords were upper-cased, since statements compare case-sensitively', () => {
      const probe = edited((sql) => replaceOnce(sql, 'begin;', 'BEGIN;'));
      expect(checkSeededTestsUnchanged(probe).passed).toBe(false);
    });
  });

  it('passes when other test files exist beside the seeded ones', () => {
    const probe = probeOf();
    if (!probe.ok) throw new Error('unreachable');
    expect(
      checkSeededTestsUnchanged({
        ...probe,
        testFiles: [...probe.testFiles, 'extra.test.sql'],
      }).passed
    ).toBe(true);
  });

  it('fails, naming the file, when a test was edited to expect the buggy total', () => {
    const tests = withEdit(1, (sql) =>
      replaceOnce(sql, '2700::bigint', '300::bigint')
    );
    expect(checkSeededTestsUnchanged(probeOf(tests))).toEqual({
      name: TESTS_UNCHANGED_CHECK,
      passed: false,
      notes: `modified: ${SEEDED_TEST_FILES[1]}`,
    });
  });

  it('fails when an assertion was removed and the plan lowered to match', () => {
    const tests = withEdit(0, (sql) =>
      replaceOnce(
        replaceOnce(sql, 'select plan(4)', 'select plan(3)'),
        "select throws_ok(\n  $$insert into public.invoice_lines (invoice_id, description, quantity, unit_price_cents)\n    values (900001, 'Nothing', 0, 100)$$,\n  '23514',\n  null,\n  'a line needs a positive quantity'\n);\n",
        ''
      )
    );
    expect(checkSeededTestsUnchanged(probeOf(tests))).toMatchObject({
      passed: false,
      notes: `modified: ${SEEDED_TEST_FILES[0]}`,
    });
  });

  it('fails when the expected value in a test was changed', () => {
    const tests = withEdit(0, (sql) =>
      replaceOnce(sql, '5500::bigint', '0::bigint')
    );
    expect(checkSeededTestsUnchanged(probeOf(tests)).passed).toBe(false);
  });

  it('fails, naming the file, when a seeded test file was deleted or renamed', () => {
    const tests = [
      { file: SEEDED_TEST_FILES[0], sql: SEEDED_TESTS[0].sql },
      { file: SEEDED_TEST_FILES[1], sql: null },
    ];
    expect(checkSeededTestsUnchanged(probeOf(tests))).toEqual({
      name: TESTS_UNCHANGED_CHECK,
      passed: false,
      notes: `missing: ${SEEDED_TEST_FILES[1]}`,
    });
  });

  it('reports a modified file and a missing file together', () => {
    const tests = [
      {
        file: SEEDED_TEST_FILES[0],
        sql: replaceOnce(SEEDED_TESTS[0].sql, '5500::bigint', '1::bigint'),
      },
      { file: SEEDED_TEST_FILES[1], sql: null },
    ];
    expect(checkSeededTestsUnchanged(probeOf(tests)).notes).toBe(
      `modified: ${SEEDED_TEST_FILES[0]}; missing: ${SEEDED_TEST_FILES[1]}`
    );
  });

  it('names every file when both were modified', () => {
    const tests = SEEDED_TESTS.map(({ file, sql }, i) => ({
      file,
      sql: replaceOnce(
        sql,
        i === 0 ? '5500::bigint' : '2700::bigint',
        '0::bigint'
      ),
    }));
    const result = checkSeededTestsUnchanged(probeOf(tests));
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(SEEDED_TEST_FILES[0]);
    expect(result.notes).toContain(SEEDED_TEST_FILES[1]);
    expect(result.notes).not.toContain('missing');
  });

  it('fails when every seeded test file is missing', () => {
    const tests = SEEDED_TEST_FILES.map((file) => ({ file, sql: null }));
    const result = checkSeededTestsUnchanged(probeOf(tests));
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(SEEDED_TEST_FILES[0]);
    expect(result.notes).toContain(SEEDED_TEST_FILES[1]);
  });

  it('fails with the probe notes when the workspace could not be read', () => {
    expect(
      checkSeededTestsUnchanged({
        ok: false,
        notes: 'could not list supabase/migrations: exit 2',
      })
    ).toEqual({
      name: TESTS_UNCHANGED_CHECK,
      passed: false,
      notes: 'could not list supabase/migrations: exit 2',
    });
  });
});

describe('diffSeededMigrations', () => {
  it('reports nothing for the seeded project', () => {
    expect(diffSeededMigrations(seededMigrations())).toEqual({
      added: [],
      modified: [],
      missing: [],
    });
  });

  it('lists a new migration file as added', () => {
    expect(
      diffSeededMigrations([
        ...seededMigrations(),
        migrationFile(FIX, FILES[FIX]),
      ])
    ).toEqual({ added: [FIX], modified: [], missing: [] });
  });

  it('lists every new migration file in the order given', () => {
    const second = '20260303000000_more.sql';
    expect(
      diffSeededMigrations([
        ...seededMigrations(),
        migrationFile(FIX, FILES[FIX]),
        migrationFile(second, 'select 1;'),
      ]).added
    ).toEqual([FIX, second]);
  });

  it('lists a seeded migration whose statements changed as modified, not added', () => {
    const [first, second] = seededMigrations();
    const fixed = replaceOnce(
      second.sql,
      'integer not null\n',
      'integer not null default 0\n'
    );
    expect(diffSeededMigrations([first, { ...second, sql: fixed }])).toEqual({
      added: [],
      modified: [second.name],
      missing: [],
    });
  });

  it('does not count added comments, blank lines or CRLF line endings as a modification', () => {
    const [first, second] = seededMigrations();
    expect(
      diffSeededMigrations([
        { ...first, sql: `-- the invoices\n\n${first.sql}\n\n` },
        { ...second, sql: second.sql.replaceAll('\n', '\r\n') },
      ])
    ).toEqual({ added: [], modified: [], missing: [] });
  });

  it('lists a seeded migration that is gone as missing, not modified', () => {
    const [first] = seededMigrations();
    expect(diffSeededMigrations([first])).toEqual({
      added: [],
      modified: [],
      missing: [SEEDED_MIGRATIONS[1]],
    });
  });

  it('lists a renamed seeded migration as one missing file and one added file', () => {
    const [first, second] = seededMigrations();
    const renamed = '20260301000000_discounts.sql';
    expect(diffSeededMigrations([first, { ...second, name: renamed }])).toEqual(
      {
        added: [renamed],
        modified: [],
        missing: [SEEDED_MIGRATIONS[1]],
      }
    );
  });

  it('lists every seeded migration as missing when there are no migration files', () => {
    expect(diffSeededMigrations([])).toEqual({
      added: [],
      modified: [],
      missing: [...SEEDED_MIGRATIONS],
    });
  });
});
