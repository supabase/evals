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

    it('returns each file as cat printed it', async () => {
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
  return text.replace(from, () => to);
};

const BETA_R1_FILE = `begin;
select plan(6);

select has_column('public', 'invoice_lines', 'discount_percent', 'invoice lines have a discount column');

insert into public.invoices (id, customer_name) values
  (900101, 'Discount Test Ltd'),
  (900102, 'Mixed Lines Ltd'),
  (900103, 'Free Sample Ltd'),
  (900104, 'Fractional Cent Ltd');

insert into public.invoice_lines (invoice_id, description, quantity, unit_price_cents, discount_percent) values
  (900101, 'Consulting hours', 2, 1500, 10),
  (900102, 'Annual licence', 1, 4000, 25),
  (900102, 'Support plan', 1, 1000, 0),
  (900103, 'Sample pack', 3, 700, 100),
  (900104, 'Small item', 1, 3, 50);

select is(
  public.invoice_total_cents(900101),
  2700::bigint,
  'a 10% discount takes 10% off the line'
);

select is(
  public.invoice_total_cents(900102),
  4000::bigint,
  'discounted and full-price lines add up'
);

select is(
  public.invoice_total_cents(900103),
  0::bigint,
  'a 100% discount makes the line free'
);

select is(
  public.invoice_total_cents(900104),
  2::bigint,
  'a fractional cent is rounded to the nearest cent'
);

select throws_ok(
  $$insert into public.invoice_lines (invoice_id, description, quantity, unit_price_cents, discount_percent)
    values (900101, 'Too generous', 1, 100, 101)$$,
  '23514',
  null,
  'a discount cannot be more than 100%'
);

select * from finish();
rollback;
`;

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
        notes: `2 seeded test files unchanged; added to ${SEEDED_TEST_FILES[1]}: 3 statements`,
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

    it('passes when the plan was only raised, with nothing to add to the notes', () => {
      expect(checkSeededTestsUnchanged(edited(withPlan(9)))).toEqual({
        name: TESTS_UNCHANGED_CHECK,
        passed: true,
        notes: '2 seeded test files unchanged',
      });
    });

    it('counts one added statement in the singular and names each extended file', () => {
      const tests = SEEDED_TESTS.map(({ file, sql }, i) => ({
        file,
        sql: replaceOnce(
          replaceOnce(
            sql,
            `select plan(${i === 0 ? 4 : 5})`,
            `select plan(${i === 0 ? 5 : 6})`
          ),
          FINISH,
          `select ok(true, 'extra');\n${FINISH}`
        ),
      }));
      expect(checkSeededTestsUnchanged(probeOf(tests)).notes).toBe(
        `2 seeded test files unchanged; added to ${SEEDED_TEST_FILES[0]}: 1 statement; added to ${SEEDED_TEST_FILES[1]}: 1 statement`
      );
    });

    it('passes when the plan is written as select * from plan(N)', () => {
      expect(
        checkSeededTestsUnchanged(
          edited((sql) =>
            replaceOnce(sql, 'select plan(5)', 'select * from plan(6)')
          )
        )
      ).toMatchObject({ passed: true, notes: '2 seeded test files unchanged' });
      expect(
        checkSeededTestsUnchanged(
          edited((sql) =>
            replaceOnce(sql, 'select plan(5)', 'select * from plan(4)')
          )
        ).passed
      ).toBe(false);
    });

    it("counts select * from plan(N) as the file's plan, so a second plan fails", () => {
      const probe = edited((sql) =>
        replaceOnce(sql, FINISH, `select * from plan(5);\n${FINISH}`)
      );
      expect(checkSeededTestsUnchanged(probe).passed).toBe(false);
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

    describe('the statements an added assertion or insert may be', () => {
      const addedAfterPlan = (statement: string, plan = 6) =>
        edited((sql) =>
          replaceOnce(
            replaceOnce(sql, 'select plan(5);', `select plan(${plan});`),
            'select * from finish();',
            `${statement}\n${FINISH}`
          )
        );
      const rejection = (statement: string, shown = statement) => ({
        name: TESTS_UNCHANGED_CHECK,
        passed: false,
        notes: `modified: ${SEEDED_TEST_FILES[1]} (added a statement the check doesn't allow: ${shown})`,
      });

      it.each([
        [
          'a set-returning assertion',
          "select * from results_eq($$select 1$$, $$select 1$$, 'same rows');",
        ],
        [
          'an assertion qualified with extensions',
          "select extensions.ok(true, 'qualified');",
        ],
        ['an assertion in capitals', "SELECT OK(true, 'loud');"],
        [
          'a prefixed assertion',
          "select col_not_null('public', 'invoice_lines', 'quantity');",
        ],
        [
          'an assertion with a nested select',
          "select is((select count(*) from public.invoices), 0::bigint, 'none');",
        ],
        [
          'an assertion that runs SQL from a string',
          "select lives_ok($$select public.invoice_total_cents(900101)$$, 'it runs');",
        ],
        [
          'a test-data insert',
          "insert into public.invoices (id, customer_name) values (900105, 'More Ltd');",
        ],
        [
          'an assertion that expects a check violation from a dollar-quoted insert',
          "select throws_ok($$insert into public.invoice_lines (invoice_id, description, quantity, unit_price_cents, discount_percent) values (900101, 'x', 1, 100, 101)$$, '23514', null, 'a discount over 100% is rejected');",
        ],
        [
          'an assertion naming columns that only contain a keyword',
          "select has_column('public', 'invoices', 'updated_at', 'is_deleted and created_by are not keywords');",
        ],
        [
          'a keyword touching a digit or a letter',
          "select ok(true, 'reset2 xcopy do_it dropped calling');",
        ],
        [
          'an insert in capitals',
          "INSERT INTO public.invoices (id, customer_name) VALUES (900105, 'More Ltd');",
        ],
        [
          'an insert whose string mentions select and returning',
          "insert into public.invoices (id, customer_name) values (900105, 'select returning');",
        ],
        [
          'an insert into a quoted, schema-qualified table',
          `insert into "public"."invoices" (id, customer_name) values (900105, 'More Ltd');`,
        ],
        [
          'an insert into a table that merely starts with t',
          "insert into public.tags (id, label) values (1, 'late');",
        ],
        [
          'an insert whose description holds a seeded id inside a longer number',
          "insert into public.invoice_lines (invoice_id, description, quantity, unit_price_cents) values (900201, 'Order 9001010 and 1900101', 1, 500);",
        ],
        [
          'an assertion that inserts data for a new invoice from a body',
          "select lives_ok($$insert into public.invoices (id, customer_name) values (900201, 'New Ltd')$$, 'a new invoice can be added');",
        ],
        [
          'an assertion that expects an insert to fail on a seeded invoice',
          "select throws_ok($$insert into public.invoice_lines (invoice_id, description, quantity, unit_price_cents, discount_percent) values (900102, 'x', 1, 100, 101)$$, '23514', null, 'the check holds on every invoice');",
        ],
        [
          'an assertion whose description mentions delete',
          "select ok(true, 'cannot delete a paid invoice');",
        ],
        [
          'an assertion whose description mentions a keyword mid-sentence',
          "select ok(true, 'users can delete a line');",
        ],
        [
          'an is whose description mentions update',
          "select is(public.invoice_total_cents(900201), 0::bigint, 'a new invoice with no lines does not update its total');",
        ],
        [
          'an assertion whose description holds an escaped quote and a keyword',
          "select ok(true, 'it''s not possible to drop a line');",
        ],
        [
          'an assertion whose escape-string description mentions a keyword',
          "select ok(true, E'it\\'s fine to delete a draft');",
        ],
        [
          'an assertion whose dollar-quoted description mentions a keyword',
          'select ok(true, $d$cannot delete a paid invoice$d$);',
        ],
        [
          'an assertion that runs a select and describes it with a keyword',
          "select lives_ok($$select public.invoice_total_cents(900101)$$, 'it does not delete anything');",
        ],
        [
          'an assertion whose description starts with a command word that is not a keyword',
          "select ok(true, 'selecting a line does not delete it');",
        ],
        [
          'an assertion whose description starts with a command word and mentions it again',
          "select ok(true, 'delete is blocked for paid invoices');",
        ],
        [
          'an assertion whose description starts with delete and says it is refused',
          "select ok(true, 'delete is refused for paid invoices');",
        ],
        [
          'an assertion whose description starts with with',
          "select ok(true, 'with no discount, totals do not change');",
        ],
        [
          'an assertion whose description starts with update',
          "select ok(true, 'update keeps the seeded totals');",
        ],
        [
          'an assertion whose description starts with truncate',
          "select ok(true, 'truncate is refused for paid invoices');",
        ],
        [
          'an assertion whose description starts with select and mentions update',
          "select ok(true, 'select does not update anything');",
        ],
        [
          'an assertion whose description starts with reset and mentions it again',
          "select ok(true, 'reset is not needed after a reset of the totals');",
        ],
        [
          'an assertion whose description starts with call',
          "select ok(true, 'call it twice and nothing changes');",
        ],
        [
          'an assertion whose description starts with copy',
          "select ok(true, 'copy of an invoice keeps its total');",
        ],
        [
          'an assertion whose description starts with grant',
          "select ok(true, 'grant is given to admins only');",
        ],
        [
          'an assertion whose description starts with drop',
          "select ok(true, 'drop the discount and the total is unchanged');",
        ],
        [
          'an assertion whose description starts with create',
          "select ok(true, 'create a line and the total updates');",
        ],
        [
          'an assertion whose escape-string description holds an ordinary escape',
          "select ok(true, E'first line\\nsecond line');",
        ],
        [
          'an assertion whose escape-string description starts with a command word and holds an escape',
          "select ok(true, E'delete is refused\\nfor paid invoices');",
        ],
      ])('passes %s', (_label, statement) => {
        expect(checkSeededTestsUnchanged(addedAfterPlan(statement))).toEqual({
          name: TESTS_UNCHANGED_CHECK,
          passed: true,
          notes: `2 seeded test files unchanged; added to ${SEEDED_TEST_FILES[1]}: 1 statement`,
        });
      });

      it('passes an insert of a new invoice and its lines together with an assertion that reads it', () => {
        const probe = addedAfterPlan(
          `insert into public.invoices (id, customer_name) values (900201, 'Extra Ltd');\ninsert into public.invoice_lines (invoice_id, description, quantity, unit_price_cents, discount_percent) values (900201, 'Extra', 1, 1000, 50), (900201, 'Second', 2, 500, 0);\nselect is(public.invoice_total_cents(900201), 1500::bigint, 'the extra lines count');`
        );
        expect(checkSeededTestsUnchanged(probe)).toMatchObject({
          passed: true,
          notes: `2 seeded test files unchanged; added to ${SEEDED_TEST_FILES[1]}: 3 statements`,
        });
      });

      it.each([
        ['todo with a count', "select todo('discount maths under review', 3);"],
        ['todo_start', "select todo_start('pending');"],
        ['todo_end', 'select todo_end();'],
        ['skip', "select skip('later', 2);"],
        ['a second finish', 'select * from finish();'],
        [
          'a bare select of another function',
          "select set_config('app.mode', 'x', true);",
        ],
        [
          'an insert that skips conflicts, since do is a keyword',
          "insert into public.invoices (id, customer_name) values (900101, 'Again') on conflict do nothing;",
        ],
        [
          'an insert of a new invoice that skips conflicts',
          "insert into public.invoices (id, customer_name) values (900201, 'Extra Ltd') on conflict do nothing;",
        ],
        [
          'an assertion that alters a table from a dollar-quoted body',
          'select lives_ok($$alter table public.invoice_lines alter column discount_percent set default 0$$);',
        ],
        [
          'an assertion that drops the function under test',
          "select throws_ok($$drop function public.invoice_total_cents(bigint)$$, '42883', null, 'it is gone');",
        ],
        [
          'an assertion that sets a config value from a dollar-quoted body',
          "select results_eq($$select set_config('search_path', 'x', true)$$, $$select 'x'::text$$, 'it is set');",
        ],
        [
          'an assertion that updates rows from a plain string',
          "select lives_ok('update public.invoice_lines set discount_percent = 0');",
        ],
        [
          'an assertion that alters a table from a dollar-quoted body, with a description',
          "select lives_ok($$alter table public.invoice_lines alter column discount_percent set default 0$$, 'x');",
        ],
        [
          'an assertion that deletes rows from a plain string, with a description',
          "select lives_ok('delete from public.invoice_lines', 'x');",
        ],
        [
          'an assertion that deletes rows from an escape string',
          "select lives_ok(E'delete from public.invoice_lines', 'x');",
        ],
        [
          'an assertion that deletes rows from a body with a tag',
          "select lives_ok($q$delete from public.invoice_lines$q$, 'x');",
        ],
        [
          'an assertion that deletes rows from a body that follows an escaped quote',
          "select lives_ok(E'select \\'x\\', 1; delete from public.invoice_lines', 'x');",
        ],
        [
          'an assertion that deletes rows from a body that opens with a comment and a parenthesis',
          "select lives_ok($$ /* note */ (update public.invoice_lines set discount_percent = 0)$$, 'x');",
        ],
        [
          'an assertion that deletes rows from a body that opens with a nested comment',
          "select lives_ok($$ /* a /* b */ c */ delete from public.invoice_lines$$, 'x');",
        ],
        [
          'an assertion that deletes rows from a body that opens with a line comment',
          "select lives_ok($$-- note\ndelete from public.invoice_lines$$, 'x');",
        ],
        [
          'an assertion that deletes rows from a body after another statement',
          "select lives_ok($$select 1; delete from public.invoice_lines$$, 'x');",
        ],
        [
          'an assertion that deletes rows from a body that opens with a semicolon',
          "select lives_ok($$;delete from public.invoice_lines$$, 'x');",
        ],
        [
          'an assertion that deletes rows from a body nested in a string',
          "select lives_ok($$select lives_ok('delete from public.invoice_lines')$$, 'x');",
        ],
        [
          'an assertion that deletes rows from an escape string that opens with a hex escape',
          "select lives_ok(E'\\x20delete from invoices', 'x');",
        ],
        [
          'an assertion that alters a table from an escape string that opens with a hex escape',
          "select lives_ok(E'\\x61lter table public.invoice_lines alter column discount_percent set default 0', 'x');",
        ],
        [
          'an assertion that deletes rows from an escape string that opens with a newline escape',
          "select lives_ok(E'\\ndelete from public.invoice_lines', 'x');",
        ],
        [
          'an assertion that deletes rows from an escape string that opens with an octal escape',
          "select lives_ok(E'\\144elete from public.invoice_lines', 'x');",
        ],
        [
          'an assertion that deletes rows from an escape string that opens with a unicode escape',
          "select lives_ok(E'\\u0064elete from public.invoice_lines', 'x');",
        ],
        [
          'an assertion that deletes rows from an escape string that opens with a long unicode escape',
          "select lives_ok(E'\\U00000064elete from public.invoice_lines', 'x');",
        ],
        [
          'an assertion that deletes rows from an escape string with a hex escape inside the first word',
          "select lives_ok(E'dele\\x74e from public.invoice_lines', 'x');",
        ],
        [
          'an assertion that deletes rows from an escape string with a backslash before a plain letter',
          "select lives_ok(E'd\\elete from public.invoice_lines', 'x');",
        ],
        [
          'an assertion that deletes rows from an escape string nested in a dollar-quoted body',
          "select lives_ok($$select lives_ok(E'\\x64elete from public.invoice_lines')$$, 'x');",
        ],
        [
          'an assertion that deletes rows from an escape string nested in a string with doubled quotes',
          "select lives_ok('select lives_ok(E''\\x64elete from public.invoice_lines'')', 'x');",
        ],
        [
          'an assertion that deletes rows from a body with a comment between the words',
          "select lives_ok($$delete /* note */ from public.invoice_lines$$, 'x');",
        ],
        [
          'an assertion that updates rows through an only table and an as alias',
          "select lives_ok($$update only public.invoice_lines as l set discount_percent = 0$$, 'x');",
        ],
        [
          'an assertion that updates rows through quoted names and a bare alias',
          `select lives_ok($$update "public"."invoice_lines" l set discount_percent = 0$$, 'x');`,
        ],
        [
          'an assertion that merges into a table',
          "select lives_ok($$merge into public.invoice_lines l using (select 1) s on true when matched then delete$$, 'x');",
        ],
        [
          'an assertion that inserts with an on conflict clause from a body',
          "select lives_ok($$insert into public.invoices (id, customer_name) values (900201, 'x') on conflict do nothing$$, 'x');",
        ],
        [
          'an assertion that runs a do block from a string',
          "select lives_ok('do $x$ begin perform 1; end $x$', 'x');",
        ],
        [
          'an assertion that runs a do block with a language from a body',
          "select lives_ok($o$do language plpgsql $x$ begin perform 1; end $x$$o$, 'x');",
        ],
        [
          'an assertion that calls a procedure from a body',
          "select lives_ok($$call public.recalculate()$$, 'x');",
        ],
        [
          'an assertion that truncates a table without the table keyword',
          "select lives_ok($$truncate public.invoice_lines$$, 'x');",
        ],
        [
          'an assertion that truncates a table with cascade',
          "select lives_ok($$truncate table public.invoice_lines cascade$$, 'x');",
        ],
        [
          'an assertion that resets search_path from a body',
          "select lives_ok($$reset search_path$$, 'x');",
        ],
        [
          'an assertion that copies a table from stdin',
          "select lives_ok($$copy public.invoice_lines from stdin$$, 'x');",
        ],
        [
          'an assertion that grants a privilege from a body',
          "select lives_ok($$grant select on public.invoices to anon$$, 'x');",
        ],
        [
          'an assertion that revokes a privilege from a body',
          "select lives_ok($$revoke all on public.invoices from anon$$, 'x');",
        ],
        [
          'an assertion that creates a temp table from a body',
          "select lives_ok($$create temp table t (x int)$$, 'x');",
        ],
        [
          'an assertion that creates a security definer function from a body',
          "select lives_ok($$create or replace function public.f() returns int language sql security definer as 'select 1'$$, 'x');",
        ],
        [
          'an assertion that comments on a table from a body',
          "select lives_ok($$comment on table public.invoices is 'x'$$, 'x');",
        ],
        [
          'an assertion that alters default privileges from a body',
          "select lives_ok($$alter default privileges grant select on tables to anon$$, 'x');",
        ],
        [
          'an assertion that drops what a role owns from a body',
          "select lives_ok($$drop owned by anon$$, 'x');",
        ],
        [
          'an assertion that drops a schema after a select from a body',
          "select lives_ok($$select 1; drop schema public cascade$$, 'x');",
        ],
        [
          'an assertion that compares the rows of a with query that deletes',
          "select results_eq($$with d as (delete from public.invoice_lines returning 1) select count(*)::int from d$$, $$select 0$$, 'x');",
        ],
        [
          'an assertion that runs a keyword in capitals',
          "select lives_ok('UPDATE public.invoice_lines SET discount_percent = 0');",
        ],
        [
          'an assertion that splits a keyword across lines',
          "select lives_ok($$comment\n  on table public.invoices is 'x'$$);",
        ],
        ['an update', 'update public.invoice_lines set discount_percent = 0;'],
        ['a delete', 'delete from public.invoice_lines;'],
        ['a drop', 'drop function public.invoice_total_cents(bigint);'],
        ['a grant', 'grant all on public.invoices to anon;'],
        ['a set', 'set local search_path = public;'],
        ['a bare set of search_path', 'set search_path to other;'],
        [
          'an assertion that sets search_path from a body',
          "select lives_ok($$set search_path = other, public$$, 'x');",
        ],
        [
          'a do block',
          "do $$ begin perform set_config('a', 'b', true); end $$;",
        ],
        [
          'an alter table',
          'alter table public.invoice_lines alter column discount_percent set default 0;',
        ],
        [
          'a not null drop',
          'alter table public.invoice_lines alter column discount_percent drop not null;',
        ],
        [
          'a redefinition of the function under test',
          'create or replace function public.invoice_total_cents(p_invoice_id bigint) returns bigint language sql as $$ select 0::bigint $$;',
        ],
        [
          'a function that shadows an assertion',
          'create function public.is(anyelement, anyelement, text) returns text language sql as $$ select extensions.ok(true, $3) $$;',
        ],
        ['a psql meta-command', '\\set QUIET on'],
        [
          'an assertion qualified with a schema other than extensions',
          "select public.ok(true, 'shadowed');",
        ],
        ['an assertion with a quoted name', `select "ok"(true, 'quoted');`],
        [
          'a select of a function that is not an assertion',
          'select public.invoice_total_cents(900101);',
        ],
        ['a select from a table', 'select * from public.invoices;'],
        [
          'an assertion followed by a todo column',
          "select ok(true, 'x'), todo('later', 3);",
        ],
        [
          'an assertion with a from clause',
          "select ok(true, 'x') from public.invoices;",
        ],
        [
          'an assertion that calls todo as an argument',
          "select is(todo('later', 3), 3, 'x');",
        ],
        [
          'an assertion that calls todo from a dollar-quoted body',
          "select lives_ok($$select todo('discount maths under review', 4)$$, 'mark the discount totals pending');",
        ],
        [
          'an assertion that calls todo from a single-quoted body',
          "select lives_ok('select todo(''pending'', 4)', 'pending');",
        ],
        [
          'an assertion that calls todo_start from a body',
          "select lives_ok($$select todo_start('pending')$$, 'pending');",
        ],
        [
          'an assertion that calls a quoted todo',
          `select ok((select true from "todo"('pending', 4) limit 1), 'pending');`,
        ],
        [
          'an assertion that calls a schema-qualified, quoted todo',
          `select ok((select true from extensions."todo"('pending', 4) limit 1), 'pending');`,
        ],
        [
          'an assertion that calls a quoted skip with a space before the parenthesis',
          `select ok((select true from "skip" ('later', 2) limit 1), 'later');`,
        ],
        [
          'an insert that writes the pgTAP todo cache',
          "insert into __tcache__ (label, value, note) values ('todo', 3, 'pending');",
        ],
        [
          'an insert into a pgTAP table in pg_temp',
          "insert into pg_temp.__tresults__ (ok, aok, descr) values (true, true, 'x');",
        ],
        [
          'an insert into a quoted pgTAP table',
          `insert into "__tcache__" (label, value, note) values ('todo', 3, 'pending');`,
        ],
        [
          'an insert into a pgTAP table qualified with public',
          "insert into public.__tcache__ (label, value, note) values ('todo', 3, 'pending');",
        ],
        [
          'an insert into the extensions schema',
          'insert into extensions.notes (id) values (1);',
        ],
        [
          'an insert into a quoted pg_catalog table',
          `insert into "pg_catalog" . "pg_class" (relname) values ('x');`,
        ],
        [
          'an insert that is missing its target',
          'insert into (id) values (1);',
        ],
        [
          'an insert of compensating lines for seeded invoices',
          "insert into public.invoice_lines (invoice_id, description, quantity, unit_price_cents, discount_percent) values (900101, 'Adjustment', 1, 2400, 100), (900102, 'Adjustment', 1, 3000, 100);",
        ],
        [
          'an insert of a seeded invoice from the other file',
          "insert into public.invoice_lines (invoice_id, description, quantity, unit_price_cents) values (900001, 'Adjustment', 1, 100);",
        ],
        [
          'an insert whose description holds a seeded id',
          "insert into public.invoice_lines (invoice_id, description, quantity, unit_price_cents) values (900201, 'Copy of 900101', 1, 100);",
        ],
        [
          'an assertion that inserts a line for a seeded invoice from a body',
          "select lives_ok($$insert into public.invoice_lines (invoice_id, description, quantity, unit_price_cents, discount_percent) values (900101, 'Adjustment', 1, 2400, 100)$$, 'adjusted');",
        ],
        [
          'an insert that updates on conflict',
          "insert into public.invoice_lines (invoice_id, description, quantity, unit_price_cents) values (900101, 'x', 1, 1) on conflict (id) do update set quantity = 0;",
        ],
        [
          'an insert that returns rows',
          "insert into public.invoices (id, customer_name) values (900105, 'x') returning id;",
        ],
        [
          'an insert from a select',
          'insert into public.invoices (id, customer_name) select id + 1000, customer_name from public.invoices;',
        ],
        [
          'a with query that inserts',
          "with i as (insert into public.invoices (id, customer_name) values (900105, 'x') returning id) select ok(true, 'x') from i;",
        ],
      ])('fails an added %s, naming the statement', (_label, statement) => {
        const { passed, notes } = checkSeededTestsUnchanged(
          addedAfterPlan(statement)
        );
        expect(passed).toBe(false);
        expect(notes).toContain(
          `modified: ${SEEDED_TEST_FILES[1]} (added a statement the check doesn't allow: ${statement.replace(/;$/, '').slice(0, 20)}`
        );
      });

      it.each(['900001', '900002', '900101', '900102', '900103'])(
        'fails an added insert that references seeded invoice %s',
        (id) => {
          const probe = addedAfterPlan(
            `insert into public.invoice_lines (invoice_id, description, quantity, unit_price_cents) values (${id}, 'Adjustment', 1, 100);`,
            5
          );
          expect(checkSeededTestsUnchanged(probe).passed).toBe(false);
        }
      );

      it.each([
        'todo',
        'todo_start',
        'todo_end',
        'in_todo',
        'skip',
        'plan',
        'no_plan',
        'finish',
      ])('fails an added assertion that calls %s from a body', (name) => {
        const bodies = [
          `select lives_ok($$select ${name}()$$);`,
          `select lives_ok('select ${name}()');`,
          `select ok((select true from "${name}"() limit 1));`,
        ];
        for (const statement of bodies) {
          expect(
            checkSeededTestsUnchanged(addedAfterPlan(statement)).passed
          ).toBe(false);
        }
      });

      it('names the raw statement when it is rejected for a quoted todo', () => {
        const statement = `select ok((select true from "todo"('pending', 4) limit 1), 'pending');`;
        expect(checkSeededTestsUnchanged(addedAfterPlan(statement))).toEqual(
          rejection(statement.replace(/;$/, ''))
        );
      });

      it.each([
        ['create', 'create table t (a int)'],
        ['alter', 'alter table t add column a int'],
        ['drop', 'drop table t'],
        ['update', 'update t set a = 1'],
        ['delete', 'delete from t'],
        ['truncate', 'truncate t'],
        ['grant', 'grant select on t to anon'],
        ['revoke', 'revoke select on t from anon'],
        ['comment on', "comment on table t is 'x'"],
        ['set_config', "select set_config('a', 'b', true)"],
        ['set role', 'set role anon'],
        ['set search_path', 'set search_path to x'],
        ['set session', 'set session authorization anon'],
        ['set local', 'set local search_path to x'],
        ['reset', 'reset search_path'],
        ['do', "do 'begin perform 1; end'"],
        ['call', 'call f()'],
        ['copy', 'copy t from stdin'],
        ['security definer', 'alter function f() security definer'],
      ])(
        'fails an added assertion whose SQL string holds %s',
        (_keyword, statement) => {
          const probe = addedAfterPlan(
            `select lives_ok($$select 1; ${statement}$$);`
          );
          expect(checkSeededTestsUnchanged(probe).passed).toBe(false);
        }
      );

      it.each([
        ['create', 'create table t (a int)'],
        ['alter', 'alter table t add column a int'],
        ['drop', 'drop table t'],
        ['update', 'update t set a = 1'],
        ['delete', 'delete from t'],
        ['truncate', 'truncate t'],
        ['grant', 'grant select on t to anon'],
        ['revoke', 'revoke select on t from anon'],
        ['comment on', "comment on table t is 'x'"],
        ['set role', 'set role anon'],
        ['set search_path', 'set search_path to x'],
        ['set session', 'set session authorization anon'],
        ['set local', 'set local search_path to x'],
        ['reset', 'reset search_path'],
        ['do', "do 'begin perform 1; end'"],
        ['call', 'call f()'],
        ['copy', 'copy t from stdin'],
        ['security definer', 'alter function f() security definer'],
      ])(
        'fails an added assertion whose SQL string starts with %s',
        (_keyword, statement) => {
          const probe = addedAfterPlan(`select lives_ok($$${statement}$$);`);
          expect(checkSeededTestsUnchanged(probe).passed).toBe(false);
        }
      );

      it('names the first disallowed statement and drops the semicolon and comments', () => {
        const probe = addedAfterPlan(
          "select ok(true, 'fine');\n-- masks the totals\nselect todo('later', 3);\nupdate public.invoices set customer_name = 'x';"
        );
        expect(checkSeededTestsUnchanged(probe)).toEqual(
          rejection("select todo('later', 3)")
        );
      });

      it('truncates a long statement to 80 characters and collapses its whitespace', () => {
        const probe = addedAfterPlan(
          `create or replace function public.invoice_total_cents(p_invoice_id bigint)\n  returns bigint language sql as $$ select 0::bigint $$;`
        );
        expect(checkSeededTestsUnchanged(probe).notes).toBe(
          `modified: ${SEEDED_TEST_FILES[1]} (added a statement the check doesn't allow: create or replace function public.invoice_total_cents(p_invoice_id bigint) retur...)`
        );
      });

      it('fails a todo added to the first file without touching the second', () => {
        const probe = probeOf(
          withEdit(0, (sql) =>
            replaceOnce(
              replaceOnce(sql, 'select plan(4);', 'select plan(5);'),
              'select * from finish();',
              "select todo('later', 1);\nselect * from finish();"
            )
          )
        );
        expect(checkSeededTestsUnchanged(probe)).toEqual({
          name: TESTS_UNCHANGED_CHECK,
          passed: false,
          notes: `modified: ${SEEDED_TEST_FILES[0]} (added a statement the check doesn't allow: select todo('later', 1))`,
        });
      });

      it('names both files when both gained a disallowed statement', () => {
        const tests = SEEDED_TESTS.map(({ file, sql }) => ({
          file,
          sql: replaceOnce(
            sql,
            'begin;',
            'begin;\nset local search_path = public;'
          ),
        }));
        expect(checkSeededTestsUnchanged(probeOf(tests)).notes).toBe(
          `modified: ${SEEDED_TEST_FILES[0]} (added a statement the check doesn't allow: set local search_path = public), ${SEEDED_TEST_FILES[1]} (added a statement the check doesn't allow: set local search_path = public)`
        );
      });

      it('gives only the file name when a seeded statement is also missing', () => {
        const probe = edited((sql) =>
          replaceOnce(
            sql,
            FIRST_IS,
            "select todo('later', 1);\nselect ok(true, 'something else');\n\n"
          )
        );
        expect(checkSeededTestsUnchanged(probe).notes).toBe(
          `modified: ${SEEDED_TEST_FILES[1]}`
        );
      });

      it('finds the seeded statements after an added psql meta-command and names the meta-command', () => {
        const probe = edited((sql) =>
          replaceOnce(sql, 'begin;\n', 'begin;\n\\set QUIET on\n')
        );
        expect(checkSeededTestsUnchanged(probe)).toEqual(
          rejection('\\set QUIET on')
        );
      });
    });
  });

  describe('with rows appended to a seeded insert', () => {
    const FILE = SEEDED_TEST_FILES[1];
    const LAST_INVOICE = "(900103, 'Free Sample Ltd')";
    const LAST_LINE = "(900103, 'Sample pack', 3, 700, 100)";

    const appendRows = (last: string, rows: string) => (sql: string) =>
      replaceOnce(sql, `${last};`, `${last},\n  ${rows};`);
    const withPlan = (sql: string) =>
      replaceOnce(sql, 'select plan(5)', 'select plan(6)');
    const edited = (...edits: Array<(sql: string) => string>) =>
      probeOf(
        withEdit(1, (sql) => edits.reduce((text, edit) => edit(text), sql))
      );
    const rejected = {
      name: TESTS_UNCHANGED_CHECK,
      passed: false,
      notes: `modified: ${FILE}`,
    };

    it('passes the file an agent left after extending both seeded inserts for a new invoice', () => {
      expect(
        checkSeededTestsUnchanged(probeOf(withEdit(1, () => BETA_R1_FILE)))
      ).toEqual({
        name: TESTS_UNCHANGED_CHECK,
        passed: true,
        notes: `2 seeded test files unchanged; added to ${FILE}: 1 statement, 2 rows appended to seeded inserts`,
      });
    });

    it('passes a row appended to the invoices insert with the lines inserted separately', () => {
      const probe = edited(
        withPlan,
        appendRows(LAST_INVOICE, "(900104, 'Fractional Cent Ltd')"),
        (sql) =>
          replaceOnce(
            sql,
            'select * from finish();',
            "insert into public.invoice_lines (invoice_id, description, quantity, unit_price_cents, discount_percent) values (900104, 'Small item', 1, 3, 50);\nselect is(public.invoice_total_cents(900104), 2::bigint, 'a fractional cent is rounded');\nselect * from finish();"
          )
      );
      expect(checkSeededTestsUnchanged(probe)).toEqual({
        name: TESTS_UNCHANGED_CHECK,
        passed: true,
        notes: `2 seeded test files unchanged; added to ${FILE}: 2 statements, 1 row appended to seeded inserts`,
      });
    });

    it('counts every appended row and leaves the statement count out when none was added', () => {
      const probe = edited(
        appendRows(
          LAST_LINE,
          "(900104, 'Small item', 1, 3, 50),\n  (900104, 'Other item', 1, 5, 0)"
        )
      );
      expect(checkSeededTestsUnchanged(probe)).toEqual({
        name: TESTS_UNCHANGED_CHECK,
        passed: true,
        notes: `2 seeded test files unchanged; added to ${FILE}: 2 rows appended to seeded inserts`,
      });
    });

    it('passes an appended row whose description mentions a keyword mid-sentence', () => {
      const probe = edited(
        withPlan,
        appendRows(LAST_INVOICE, "(900104, 'cannot delete')")
      );
      expect(checkSeededTestsUnchanged(probe)).toEqual({
        name: TESTS_UNCHANGED_CHECK,
        passed: true,
        notes: `2 seeded test files unchanged; added to ${FILE}: 1 row appended to seeded inserts`,
      });
    });

    it('passes an appended row whose description starts with a command word and holds a keyword', () => {
      const probe = edited(
        withPlan,
        appendRows(LAST_INVOICE, "(900104, 'delete is refused')")
      );
      expect(checkSeededTestsUnchanged(probe)).toEqual({
        name: TESTS_UNCHANGED_CHECK,
        passed: true,
        notes: `2 seeded test files unchanged; added to ${FILE}: 1 row appended to seeded inserts`,
      });
    });

    it('passes appended rows spread over lines, comments and extra spaces', () => {
      const probe = edited(
        appendRows(
          LAST_LINE,
          "-- a fractional cent\n  (900104,'Small item',1,3,50)\n  /* and another */ ,\n  (  900104 , 'Other item' , 1 , 5 , 0 )"
        )
      );
      expect(checkSeededTestsUnchanged(probe).passed).toBe(true);
    });

    it('passes appended rows when the seeded insert was reflowed onto one line', () => {
      const probe = edited((sql) =>
        replaceOnce(
          sql,
          "values\n  (900101, 'Discount Test Ltd'),\n  (900102, 'Mixed Lines Ltd'),\n  (900103, 'Free Sample Ltd');",
          "values (900101, 'Discount Test Ltd'), (900102, 'Mixed Lines Ltd'), (900103, 'Free Sample Ltd'), (900104, 'Fractional Cent Ltd');"
        )
      );
      expect(checkSeededTestsUnchanged(probe).passed).toBe(true);
    });

    it.each([
      [
        'a row for a seeded invoice',
        appendRows(LAST_LINE, "(900101, 'Adjustment', 1, 2400, 100)"),
      ],
      [
        'a new invoice row next to one for a seeded invoice',
        appendRows(
          LAST_LINE,
          "(900104, 'Small item', 1, 3, 50),\n  (900102, 'Adjustment', 1, 3000, 100)"
        ),
      ],
      [
        'a seeded invoice id in a description',
        appendRows(LAST_LINE, "(900104, 'Copy of 900101', 1, 3, 50)"),
      ],
      [
        'a row for a seeded invoice on the invoices insert',
        appendRows(LAST_INVOICE, "(900101, 'Again')"),
      ],
      [
        'a row inserted before the last seeded row',
        (sql: string) =>
          replaceOnce(
            sql,
            `  ${LAST_LINE}`,
            `  (900104, 'Small item', 1, 3, 50),\n  ${LAST_LINE}`
          ),
      ],
      [
        'a row inserted before the first seeded row',
        (sql: string) =>
          replaceOnce(
            sql,
            "values\n  (900101, 'Discount Test Ltd')",
            "values\n  (900104, 'Fractional Cent Ltd'),\n  (900101, 'Discount Test Ltd')"
          ),
      ],
      [
        'a changed seeded row next to an appended one',
        (sql: string) =>
          appendRows(
            "(900103, 'Sample pack', 3, 700, 0)",
            "(900104, 'Small item', 1, 3, 50)"
          )(replaceOnce(sql, LAST_LINE, "(900103, 'Sample pack', 3, 700, 0)")),
      ],
      [
        'a removed seeded row next to an appended one',
        (sql: string) =>
          appendRows(
            LAST_LINE,
            "(900104, 'Small item', 1, 3, 50)"
          )(replaceOnce(sql, "  (900102, 'Support plan', 1, 1000, 0),\n", '')),
      ],
      [
        'a removed last seeded row next to an appended one',
        (sql: string) =>
          replaceOnce(
            sql,
            `  (900102, 'Support plan', 1, 1000, 0),\n  ${LAST_LINE};`,
            "  (900102, 'Support plan', 1, 1000, 0),\n  (900104, 'Small item', 1, 3, 50);"
          ),
      ],
      [
        'a tail that skips conflicts',
        appendRows(
          LAST_LINE,
          "(900104, 'Small item', 1, 3, 50) on conflict do nothing"
        ),
      ],
      [
        'a tail that returns rows',
        appendRows(
          LAST_INVOICE,
          "(900104, 'Fractional Cent Ltd') returning id"
        ),
      ],
      [
        'a tuple that calls todo',
        appendRows(LAST_INVOICE, "(900104, (select todo('x', 1)))"),
      ],
      [
        'a tuple with a sub-select',
        appendRows(LAST_INVOICE, "(900104, (select 'Fractional Cent Ltd'))"),
      ],
      [
        'a tuple that holds a state-changing keyword',
        appendRows(LAST_INVOICE, "(900104, 'drop table')"),
      ],
      [
        'a tuple whose escape-string description opens with a hex escape and then deletes',
        appendRows(LAST_INVOICE, "(900104, E'\\x20delete from invoices')"),
      ],
      [
        'a tuple that names a quoted todo call',
        appendRows(LAST_INVOICE, `(900104, "todo"('x', 1))`),
      ],
      [
        'tuples with no comma between them',
        appendRows(
          LAST_LINE,
          "(900104, 'Small item', 1, 3, 50)\n  (900104, 'Other item', 1, 5, 0)"
        ),
      ],
      [
        'a tuple that is never closed',
        appendRows(LAST_LINE, "(900104, 'Small item', 1, 3, 50"),
      ],
      [
        'a trailing comma with no tuple after it',
        (sql: string) => replaceOnce(sql, `${LAST_LINE};`, `${LAST_LINE},;`),
      ],
      ['a value that is not a tuple', appendRows(LAST_LINE, '900104')],
      [
        'text appended to a seeded assertion',
        (sql: string) =>
          replaceOnce(
            sql,
            "'a 10% discount takes 10% off the line'\n);",
            "'a 10% discount takes 10% off the line'\n), (900104, 'x');"
          ),
      ],
      [
        'a row appended to a seeded dollar-quoted insert',
        (sql: string) =>
          replaceOnce(
            sql,
            "values (900101, 'Too generous', 1, 100, 101)$$",
            "values (900101, 'Too generous', 1, 100, 101), (900104, 'x', 1, 1, 1)$$"
          ),
      ],
    ])('fails %s', (_label, edit) => {
      expect(checkSeededTestsUnchanged(edited(withPlan, edit))).toEqual(
        rejected
      );
    });

    it('fails when the plan was lowered below the seeded count with rows appended', () => {
      const probe = edited(
        (sql) => replaceOnce(sql, 'select plan(5)', 'select plan(4)'),
        appendRows(LAST_LINE, "(900104, 'Small item', 1, 3, 50)")
      );
      expect(checkSeededTestsUnchanged(probe)).toEqual(rejected);
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
