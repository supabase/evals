// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-001-rls-policy-tests
//
// Interface assumptions the design leaves open:
// - Test files are workspace-relative paths (`supabase/tests/<name>`), passed to psql as `-f <path>`.
// - listTestFiles shells out to `find supabase/tests ...`; the fake answers with every file under the
//   directory, unfiltered and unsorted, so the module filters `*.sql`/`*.pg` and sorts itself. A missing
//   directory is find's "No such file or directory" failure.
// - The pgtap probe is one psql command mentioning pg_extension; the fake answers in the shape the query asks for.
import type { CommandResult } from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import type { StackProbe } from '../lib/stack.js';
import { SEEDED_NOTES_POLICIES } from './fixtures.js';
import {
  buildMutationSql,
  checkTestsCatchSeededPolicies,
  checkTestsPass,
  listTestFiles,
  parseTap,
  runSuite,
  tapPassed,
  TESTS_CATCH_CHECK_NAME,
  TESTS_PASS_CHECK_NAME,
  withPgtap,
  type SuiteProbe,
  type TapResult,
  type TestFileRun,
} from './pgtap.js';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: DB_URL,
  runtime: 'native',
};

const MARKER = 'eval-mutation-applied';
const A = 'supabase/tests/a_test.sql';
const B = 'supabase/tests/b_test.sql';

const D1 = 'owner sees their own notes';
const D2 = "other user sees none of the owner's notes";
const D3 = 'anon sees no notes';

const PASSING = `1..3
ok 1 - a sees one note
ok 2 - b sees one note
ok 3 - anon sees nothing
`;

const FAILING_WITHOUT_ERROR = `1..3
not ok 1 - a sees one note
# Failed test 1: "a sees one note"
#         have: 2
#         want: 1
not ok 2 - b sees one note
# Failed test 2: "b sees one note"
#         have: 2
#         want: 1
ok 3 - anon sees nothing
# Looks like you failed 2 tests of 3
`;

const FAILING_WITH_ERROR = `1..3
not ok 1 - a sees one note
# Failed test 1: "a sees one note"
#         have: 2
#         want: 1
`;

function result(
  stdout: string,
  ok = true,
  stderr = '',
  exitCode = ok ? 0 : 1
): CommandResult {
  return { ok, exitCode, stdout, stderr };
}

const scriptOf = (command: string) => {
  const payload = command
    .match(/[A-Za-z0-9+/]{80,}={0,2}/g)
    ?.sort((a, b) => b.length - a.length)[0];
  return payload === undefined
    ? command
    : Buffer.from(payload, 'base64').toString('utf8');
};

const entry = (
  ok: boolean,
  number: number | null,
  description: string,
  todo = false
) => ({ ok, number, description, todo });

describe('check names', () => {
  it('are the documented ones', () => {
    expect(TESTS_PASS_CHECK_NAME).toBe(
      "the project's pgTAP tests pass against the local database"
    );
    expect(TESTS_CATCH_CHECK_NAME).toBe(
      'the tests fail when the seeded notes policies are put back'
    );
  });
});

describe('parseTap', () => {
  it('reads a passing file', () => {
    expect(parseTap(PASSING)).toEqual({
      planned: 3,
      plans: 1,
      results: [
        entry(true, 1, 'a sees one note'),
        entry(true, 2, 'b sees one note'),
        entry(true, 3, 'anon sees nothing'),
      ],
    });
  });

  it('reads a file whose tests fail without an error', () => {
    expect(parseTap(FAILING_WITHOUT_ERROR)).toEqual({
      planned: 3,
      plans: 1,
      results: [
        entry(false, 1, 'a sees one note'),
        entry(false, 2, 'b sees one note'),
        entry(true, 3, 'anon sees nothing'),
      ],
    });
  });

  it('reads a file that stopped after its first failure', () => {
    expect(parseTap(FAILING_WITH_ERROR)).toEqual({
      planned: 3,
      plans: 1,
      results: [entry(false, 1, 'a sees one note')],
    });
  });

  it('reads the plan from the end of a no_plan() file', () => {
    const tap = parseTap('ok 1 - first\nok 2 - second\n1..2\n');
    expect(tap).toEqual({
      planned: 2,
      plans: 1,
      results: [entry(true, 1, 'first'), entry(true, 2, 'second')],
    });
  });

  it('reads a skipped file as a plan of zero with no results', () => {
    expect(parseTap('1..0 # SKIP nothing to test\n')).toEqual({
      planned: 0,
      plans: 1,
      results: [],
    });
  });

  it('marks a failing test with a TODO directive as todo and strips the directive from its description', () => {
    expect(
      parseTap('1..3\nok 1 - a\nok 2 - b\nnot ok 3 - x # TODO later\n')
    ).toEqual({
      planned: 3,
      plans: 1,
      results: [
        entry(true, 1, 'a'),
        entry(true, 2, 'b'),
        entry(false, 3, 'x', true),
      ],
    });
  });

  it('ignores diagnostics, blank lines and psql noise between results', () => {
    const tap = parseTap(`
1..2

# Subtest: setup
ok 1 - first

# not ok 9 - this is a comment
#         have: ok 5 - also a comment
psql:/tmp/x.sql:4: NOTICE:  something
not ok 2 - second
# Failed test 2: "second"
`);
    expect(tap).toEqual({
      planned: 2,
      plans: 1,
      results: [entry(true, 1, 'first'), entry(false, 2, 'second')],
    });
  });

  it('reads a result with no test number as number null', () => {
    expect(parseTap('1..1\nok - unnumbered\n').results).toEqual([
      entry(true, null, 'unnumbered'),
    ]);
  });

  it('counts every plan line', () => {
    expect(parseTap('1..2\nok 1 - a\n1..2\nok 2 - b\n')).toMatchObject({
      plans: 2,
    });
  });

  it('reads output with no plan and no results as nothing', () => {
    expect(parseTap('')).toEqual({ planned: null, plans: 0, results: [] });
    expect(parseTap('psql: error: connection refused\n')).toEqual({
      planned: null,
      plans: 0,
      results: [],
    });
  });
});

describe('tapPassed', () => {
  const tap = (
    results: TapResult['results'],
    planned: number | null = results.length,
    plans = planned === null ? 0 : 1
  ): TapResult => ({ planned, plans, results });
  const oks = (n: number): TapResult['results'] =>
    Array.from({ length: n }, (_, i) => entry(true, i + 1, `t${i + 1}`));

  it('passes a complete file with exit 0, one plan and no failure', () => {
    expect(tapPassed(0, parseTap(PASSING))).toBe(true);
  });

  it('passes a no_plan() file whose plan comes last', () => {
    expect(tapPassed(0, parseTap('ok 1 - a\nok 2 - b\n1..2\n'))).toBe(true);
  });

  it('passes a skipped file', () => {
    expect(tapPassed(0, parseTap('1..0 # SKIP\n'))).toBe(true);
  });

  it('passes a file whose only failure is a TODO test', () => {
    expect(
      tapPassed(0, parseTap('1..2\nok 1 - a\nnot ok 2 - b # TODO later\n'))
    ).toBe(true);
  });

  it('fails a file with a failing test even though psql exited 0', () => {
    expect(tapPassed(0, parseTap(FAILING_WITHOUT_ERROR))).toBe(false);
  });

  it('fails exit 3, the status psql returns when ON_ERROR_STOP hit an error', () => {
    expect(tapPassed(3, parseTap(FAILING_WITH_ERROR))).toBe(false);
  });

  it('fails a non-zero exit even when every planned test passed', () => {
    expect(tapPassed(3, parseTap(PASSING))).toBe(false);
  });

  it('fails when psql was killed and has no exit code', () => {
    expect(tapPassed(null, parseTap(PASSING))).toBe(false);
  });

  it('fails a file with results but no plan', () => {
    expect(tapPassed(0, tap(oks(2), null))).toBe(false);
  });

  it('fails a file with no output at all', () => {
    expect(tapPassed(0, parseTap(''))).toBe(false);
  });

  it('fails a file with two plans', () => {
    expect(tapPassed(0, tap(oks(2), 2, 2))).toBe(false);
  });

  it('fails when fewer results ran than were planned', () => {
    expect(tapPassed(0, tap(oks(2), 3))).toBe(false);
  });

  it('fails when more results ran than were planned', () => {
    expect(tapPassed(0, tap(oks(3), 2))).toBe(false);
  });
});

describe('listTestFiles', () => {
  function listing(
    options: { files?: string[] | null; failure?: string; throws?: string } = {}
  ) {
    const exec = vi.fn(async (_command: string): Promise<CommandResult> => {
      if (options.throws !== undefined) throw new Error(options.throws);
      if (options.failure !== undefined) {
        return result('', false, options.failure, 1);
      }
      if (options.files === null) {
        return result(
          '',
          false,
          "find: 'supabase/tests': No such file or directory",
          1
        );
      }
      return result(
        (options.files ?? []).map((file) => `supabase/tests/${file}`).join('\n')
      );
    });
    return { exec };
  }

  it('lists *.sql and *.pg files recursively, sorted, and nothing else', async () => {
    const ctx = listing({
      files: [
        'z_test.pg',
        'README.md',
        'nested/deep/c.pg',
        'a_test.sql',
        'notes.sql.bak',
        'helper.sh',
        '.gitkeep',
        'nested/b_test.sql',
        'sql',
      ],
    });
    expect(await listTestFiles(ctx)).toEqual({
      ok: true,
      files: [
        'supabase/tests/a_test.sql',
        'supabase/tests/nested/b_test.sql',
        'supabase/tests/nested/deep/c.pg',
        'supabase/tests/z_test.pg',
      ],
    });
  });

  it('ignores blank lines in the listing', async () => {
    const exec = vi.fn(async () =>
      result('\nsupabase/tests/a_test.sql\n\n  \n')
    );
    expect(await listTestFiles({ exec })).toEqual({
      ok: true,
      files: ['supabase/tests/a_test.sql'],
    });
  });

  it('finds no files in an empty directory', async () => {
    expect(await listTestFiles(listing({ files: [] }))).toEqual({
      ok: true,
      files: [],
    });
  });

  it('finds no files, without failing the probe, when the directory does not exist', async () => {
    expect(await listTestFiles(listing({ files: null }))).toEqual({
      ok: true,
      files: [],
    });
  });

  it('fails the probe when the listing fails for another reason', async () => {
    const probe = await listTestFiles(
      listing({ failure: "find: 'supabase/tests': Permission denied" })
    );
    expect(probe).toEqual({
      ok: false,
      notes: expect.stringContaining('Permission denied'),
    });
  });

  it('reports a thrown exec instead of rejecting', async () => {
    expect(await listTestFiles(listing({ throws: 'sandbox gone' }))).toEqual({
      ok: false,
      notes: expect.stringContaining('sandbox gone'),
    });
  });
});

describe('buildMutationSql', () => {
  const sql = buildMutationSql();
  const trimmed = sql.trim();

  it('starts a transaction and never ends it', () => {
    expect(trimmed).toMatch(/^begin\b/i);
    expect(sql).not.toMatch(/\b(commit|rollback)\b/i);
  });

  it('drops every policy on public.notes by looping over pg_policies', () => {
    expect(sql).toMatch(/pg_policies/i);
    expect(sql).toMatch(/\bnotes\b/);
    expect(sql).toMatch(/\bdrop policy\b/i);
    expect(sql).toMatch(/\bloop\b/i);
  });

  it('enables row level security on public.notes', () => {
    expect(sql).toMatch(
      /alter table\s+(only\s+)?public\.notes\s+enable row level security/i
    );
  });

  it('recreates every seeded policy verbatim, each as its own statement', () => {
    for (const statement of SEEDED_NOTES_POLICIES) {
      expect(sql).toContain(`${statement};`);
    }
  });

  it('drops the existing policies before it recreates the seeded ones', () => {
    const drop = sql.search(/\bdrop policy\b/i);
    const first = sql.indexOf(SEEDED_NOTES_POLICIES[0]);
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(drop).toBeLessThan(first);
  });

  it('ends by selecting the marker that proves it applied', () => {
    expect(trimmed).toMatch(/select 'eval-mutation-applied';?$/i);
    const last = sql.lastIndexOf(SEEDED_NOTES_POLICIES.at(-1) ?? '');
    expect(sql.indexOf(MARKER)).toBeGreaterThan(last);
  });
});

type Run = { stdout: string; exitCode?: number; stderr?: string };
type Behaviour = { clean: Run; mutated?: Run; rerun?: Run };
type Db = {
  files?: string[] | null;
  listFailure?: string;
  pgtap?: boolean;
  behaviour?: Record<string, Behaviour>;
  createFails?: boolean;
  probeFails?: boolean;
  throws?: string;
};

const tapText = (
  descriptions: readonly string[],
  failing: readonly number[] = []
) =>
  [
    `1..${descriptions.length}`,
    ...descriptions.flatMap((description, i) =>
      failing.includes(i + 1)
        ? [
            `not ok ${i + 1} - ${description}`,
            `# Failed test ${i + 1}: "${description}"`,
            '#         have: 2',
            '#         want: 0',
          ]
        : [`ok ${i + 1} - ${description}`]
    ),
    ...(failing.length > 0
      ? [
          `# Looks like you failed ${failing.length} tests of ${descriptions.length}`,
        ]
      : []),
    '',
  ].join('\n');

const DESCRIPTIONS = [D1, D2, D3];
const cleanPass: Run = { stdout: tapText(DESCRIPTIONS) };
const mutatedFail: Run = {
  stdout: `${MARKER}\n${tapText(DESCRIPTIONS, [2])}`,
};
const CATCHING: Behaviour = {
  clean: cleanPass,
  mutated: mutatedFail,
  rerun: cleanPass,
};

function pgtapAnswer(command: string, present: boolean): string {
  if (/count\s*\(/i.test(command)) return present ? '1\n' : '0\n';
  if (/\bexists\s*\(/i.test(command)) return present ? 't\n' : 'f\n';
  if (/select\s+extname/i.test(command)) return present ? 'pgtap\n' : '';
  return present ? '1\n' : '';
}

function fakeDb(db: Db = {}) {
  const log: string[] = [];
  const psqlTestCommands: string[] = [];
  const state = { pgtap: db.pgtap ?? false };
  const dirty = new Set<string>();

  const exec = vi.fn(async (command: string): Promise<CommandResult> => {
    if (db.throws !== undefined) throw new Error(db.throws);
    if (!/\bpsql\b/.test(command)) {
      if (!command.includes('supabase/tests')) {
        return result('', false, `unexpected command: ${command}`);
      }
      log.push('list');
      if (db.listFailure !== undefined) {
        return result('', false, db.listFailure, 1);
      }
      if (db.files === null) {
        return result(
          '',
          false,
          "find: 'supabase/tests': No such file or directory",
          1
        );
      }
      return result(
        [...(db.files ?? ['a_test.sql'])]
          .reverse()
          .map((file) => `supabase/tests/${file}`)
          .join('\n')
      );
    }
    if (!command.includes(DB_URL)) {
      return result(
        '',
        false,
        'psql: error: connection to server failed: Connection refused',
        2
      );
    }
    if (command.includes('pg_extension')) {
      log.push('probe-extension');
      if (db.probeFails)
        return result('', false, 'psql: error: no pg_extension', 2);
      return result(pgtapAnswer(command, state.pgtap));
    }
    if (/create\s+extension/i.test(command)) {
      log.push('create-extension');
      if (db.createFails) {
        return result(
          '',
          false,
          'ERROR:  could not open extension control file "/usr/share/postgresql/17/extension/pgtap.control"',
          3
        );
      }
      state.pgtap = true;
      return result('');
    }
    if (/drop\s+extension/i.test(command)) {
      log.push('drop-extension');
      state.pgtap = false;
      return result('');
    }

    const fileArgs = [
      ...command.matchAll(/(?:^|\s)-f\s+('[^']*'|"[^"]*"|\S+)/g),
    ].map(([, arg]) => arg.replace(/^['"]|['"]$/g, ''));
    const target = fileArgs.find((arg) => arg !== '-');
    const key = target?.replace(/^.*supabase\/tests\//, '');
    const behaviour = key === undefined ? undefined : db.behaviour?.[key];
    if (key === undefined || behaviour === undefined) {
      return result('', false, `unexpected command: ${command}`);
    }
    psqlTestCommands.push(command);
    const run = (output: Run) =>
      result(
        output.stdout,
        (output.exitCode ?? 0) === 0,
        output.stderr ?? '',
        output.exitCode ?? 0
      );
    if (fileArgs.includes('-') && scriptOf(command).includes(MARKER)) {
      log.push(`mutate ${key}`);
      dirty.add(key);
      return run(behaviour.mutated ?? behaviour.clean);
    }
    if (dirty.delete(key)) {
      log.push(`rerun ${key}`);
      return run(behaviour.rerun ?? behaviour.clean);
    }
    log.push(`clean ${key}`);
    return run(behaviour.clean);
  });

  return { exec, log, psqlTestCommands, state };
}

const forFile = (log: string[], name: string) =>
  log.filter((line) => line.endsWith(` ${name}`));

describe('withPgtap', () => {
  it('creates pgtap before the callback and drops it after when it was not installed', async () => {
    const db = fakeDb({ pgtap: false });
    const value = await withPgtap(db, DB_URL, async () => {
      db.log.push('callback');
      return 42;
    });
    expect(value).toBe(42);
    expect(db.log).toEqual([
      'probe-extension',
      'create-extension',
      'callback',
      'drop-extension',
    ]);
    expect(db.state.pgtap).toBe(false);
  });

  it('creates pgtap in the extensions schema and drops it with if exists', async () => {
    const db = fakeDb({ pgtap: false });
    await withPgtap(db, DB_URL, async () => undefined);
    const commands = db.exec.mock.calls.map(([command]) => command);
    expect(
      commands.some((c) =>
        /create extension if not exists pgtap with schema extensions/i.test(c)
      )
    ).toBe(true);
    expect(
      commands.some((c) => /drop extension if exists pgtap/i.test(c))
    ).toBe(true);
  });

  it('neither creates nor drops pgtap when it was already installed', async () => {
    const db = fakeDb({ pgtap: true });
    await withPgtap(db, DB_URL, async () => {
      db.log.push('callback');
    });
    expect(db.log).toEqual(['probe-extension', 'callback']);
    expect(db.state.pgtap).toBe(true);
  });

  it('drops pgtap again when the callback throws', async () => {
    const db = fakeDb({ pgtap: false });
    await withPgtap(db, DB_URL, async () => {
      throw new Error('boom');
    }).catch(() => undefined);
    expect(db.log.at(-1)).toBe('drop-extension');
    expect(db.state.pgtap).toBe(false);
  });

  it('fails without running the callback when pgtap cannot be created', async () => {
    const db = fakeDb({ pgtap: false, createFails: true });
    const callback = vi.fn(async () => 'ran');
    expect(await withPgtap(db, DB_URL, callback)).toEqual({
      ok: false,
      notes: expect.stringContaining('pgtap.control'),
    });
    expect(callback).not.toHaveBeenCalled();
  });

  it('fails without running the callback when the extension probe fails', async () => {
    const db = fakeDb({ probeFails: true });
    const callback = vi.fn(async () => 'ran');
    expect(await withPgtap(db, DB_URL, callback)).toMatchObject({ ok: false });
    expect(callback).not.toHaveBeenCalled();
  });
});

describe('runSuite', () => {
  const suiteOf = async (db: Db) => {
    const ctx = fakeDb(db);
    return { ctx, suite: await runSuite(ctx, STACK) };
  };

  it('runs every file clean, then mutates and re-runs only the files that passed', async () => {
    const { ctx, suite } = await suiteOf({
      files: ['a_test.sql', 'b_test.sql'],
      behaviour: {
        'a_test.sql': CATCHING,
        'b_test.sql': {
          clean: { stdout: tapText(DESCRIPTIONS, [1]) },
        },
      },
    });
    expect(suite).toMatchObject({
      ok: true,
      files: [A, B],
      clean: [
        { file: A, passed: true },
        { file: B, passed: false },
      ],
      catches: [
        {
          file: A,
          mutated: { passed: false, mutationApplied: true },
          rerun: { passed: true },
        },
      ],
    });
    expect(forFile(ctx.log, 'a_test.sql')).toEqual([
      'clean a_test.sql',
      'mutate a_test.sql',
      'rerun a_test.sql',
    ]);
    expect(forFile(ctx.log, 'b_test.sql')).toEqual(['clean b_test.sql']);
  });

  it('parses each clean run into its tap and keeps the psql exit code', async () => {
    const { suite } = await suiteOf({
      files: ['a_test.sql'],
      behaviour: {
        'a_test.sql': {
          clean: {
            stdout: FAILING_WITH_ERROR,
            exitCode: 3,
            stderr: 'psql:a_test.sql:12: ERROR:  more than one row',
          },
        },
      },
    });
    expect(suite).toMatchObject({
      ok: true,
      clean: [
        {
          file: A,
          passed: false,
          exitCode: 3,
          tap: {
            planned: 3,
            results: [{ ok: false, description: 'a sees one note' }],
          },
        },
      ],
      catches: [],
    });
  });

  it('reports a file whose tests pass under the mutation as not caught', async () => {
    const { suite } = await suiteOf({
      behaviour: {
        'a_test.sql': {
          clean: cleanPass,
          mutated: { stdout: `${MARKER}\n${tapText([D3])}` },
          rerun: cleanPass,
        },
      },
    });
    expect(suite).toMatchObject({
      ok: true,
      catches: [{ file: A, mutated: { passed: true, mutationApplied: true } }],
    });
  });

  it('reports mutationApplied false when the marker never printed', async () => {
    const { suite } = await suiteOf({
      behaviour: {
        'a_test.sql': {
          clean: cleanPass,
          mutated: {
            stdout: '',
            exitCode: 2,
            stderr: 'psql: error: connection refused',
          },
          rerun: cleanPass,
        },
      },
    });
    expect(suite).toMatchObject({
      ok: true,
      catches: [
        { file: A, mutated: { passed: false, mutationApplied: false } },
      ],
    });
  });

  it('reports a re-run that fails after a mutation that caught the tests', async () => {
    const { suite } = await suiteOf({
      behaviour: {
        'a_test.sql': {
          clean: cleanPass,
          mutated: mutatedFail,
          rerun: { stdout: tapText(DESCRIPTIONS, [3]) },
        },
      },
    });
    expect(suite).toMatchObject({
      ok: true,
      catches: [
        {
          file: A,
          mutated: { passed: false, mutationApplied: true },
          rerun: { passed: false },
        },
      ],
    });
  });

  it('sends the mutation, the test file and a rollback to one psql session, in that order', async () => {
    const { ctx } = await suiteOf({ behaviour: { 'a_test.sql': CATCHING } });
    const mutation = ctx.psqlTestCommands.find((command) =>
      /-f -(\s|$)/.test(command)
    );
    expect(mutation).toBeDefined();
    const command = mutation ?? '';
    expect(command).toContain(`'${DB_URL}'`);
    expect(command).toContain('-v ON_ERROR_STOP=1');
    const stdin = command.search(/-f -(\s|$)/);
    const file = command.indexOf(A);
    const rollback = command.search(/-c\s+['"]?rollback['"]?/);
    expect(stdin).toBeGreaterThanOrEqual(0);
    expect(file).toBeGreaterThan(stdin);
    expect(rollback).toBeGreaterThan(file);
    expect(scriptOf(command)).toContain(buildMutationSql().trim());
  });

  it('runs every clean and re-run file with ON_ERROR_STOP so an error surfaces as a non-zero exit', async () => {
    const { ctx } = await suiteOf({ behaviour: { 'a_test.sql': CATCHING } });
    expect(ctx.psqlTestCommands).toHaveLength(3);
    for (const command of ctx.psqlTestCommands) {
      expect(command).toContain('-v ON_ERROR_STOP=1');
      expect(command).toContain(A);
    }
    const plain = ctx.psqlTestCommands.filter(
      (command) => !/-f -(\s|$)/.test(command)
    );
    for (const command of plain) expect(command).not.toContain('rollback');
  });

  it('creates pgtap before the first test file and drops it as the very last command when it was not installed', async () => {
    const { ctx, suite } = await suiteOf({
      pgtap: false,
      files: ['a_test.sql'],
      behaviour: { 'a_test.sql': CATCHING },
    });
    expect(suite).toMatchObject({ ok: true });
    expect(ctx.log.filter((line) => line.endsWith('extension'))).toEqual([
      'probe-extension',
      'create-extension',
      'drop-extension',
    ]);
    expect(ctx.log.indexOf('create-extension')).toBeLessThan(
      ctx.log.indexOf('clean a_test.sql')
    );
    expect(ctx.log.at(-1)).toBe('drop-extension');
    expect(ctx.state.pgtap).toBe(false);
  });

  it('drops pgtap even when no file passes clean', async () => {
    const { ctx } = await suiteOf({
      pgtap: false,
      behaviour: {
        'a_test.sql': { clean: { stdout: tapText(DESCRIPTIONS, [1]) } },
      },
    });
    expect(ctx.log.at(-1)).toBe('drop-extension');
  });

  it('leaves pgtap alone when it was already installed', async () => {
    const { ctx } = await suiteOf({
      pgtap: true,
      behaviour: { 'a_test.sql': CATCHING },
    });
    expect(ctx.log).not.toContain('create-extension');
    expect(ctx.log).not.toContain('drop-extension');
    expect(ctx.state.pgtap).toBe(true);
  });

  it('finds no files, runs nothing and stays ok when the tests directory is empty', async () => {
    const { ctx, suite } = await suiteOf({ files: [] });
    expect(suite).toEqual({ ok: true, files: [], clean: [], catches: [] });
    expect(ctx.psqlTestCommands).toEqual([]);
  });

  it('finds no files and stays ok when the tests directory does not exist', async () => {
    const { suite } = await suiteOf({ files: null });
    expect(suite).toEqual({ ok: true, files: [], clean: [], catches: [] });
  });

  it('fails with the stack notes, without running anything, when the stack did not resolve', async () => {
    const ctx = fakeDb({ behaviour: { 'a_test.sql': CATCHING } });
    const suite = await runSuite(ctx, {
      ok: false,
      notes: 'managed: exit 1: no stack running',
    });
    expect(suite).toEqual({
      ok: false,
      notes: expect.stringContaining('no stack running'),
    });
    expect(ctx.exec).not.toHaveBeenCalled();
  });

  it('fails when the listing fails for a reason other than a missing directory', async () => {
    const { suite } = await suiteOf({
      listFailure: "find: 'supabase/tests': Permission denied",
    });
    expect(suite).toEqual({
      ok: false,
      notes: expect.stringContaining('Permission denied'),
    });
  });

  it('fails without running any test file when pgtap cannot be created', async () => {
    const { ctx, suite } = await suiteOf({
      pgtap: false,
      createFails: true,
      behaviour: { 'a_test.sql': CATCHING },
    });
    expect(suite).toEqual({
      ok: false,
      notes: expect.stringContaining('pgtap.control'),
    });
    expect(ctx.psqlTestCommands).toEqual([]);
  });

  it('reports a thrown exec instead of rejecting', async () => {
    const { suite } = await suiteOf({ throws: 'sandbox gone' });
    expect(suite).toEqual({
      ok: false,
      notes: expect.stringContaining('sandbox gone'),
    });
  });
});

describe('check helpers', () => {
  const tapOfRun = (
    descriptions: readonly string[],
    failing: readonly number[],
    planned: number | null = descriptions.length
  ): TapResult => ({
    planned,
    plans: planned === null ? 0 : 1,
    results: descriptions.map((description, i) =>
      entry(!failing.includes(i + 1), i + 1, description)
    ),
  });

  const run = (
    file: string,
    options: {
      descriptions?: readonly string[];
      failing?: readonly number[];
      planned?: number | null;
      exitCode?: number | null;
      detail?: string;
    } = {}
  ): TestFileRun => {
    const descriptions = options.descriptions ?? DESCRIPTIONS;
    const failing = options.failing ?? [];
    const tap = tapOfRun(descriptions, failing, options.planned);
    const exitCode = options.exitCode === undefined ? 0 : options.exitCode;
    return {
      file,
      passed:
        exitCode === 0 &&
        failing.length === 0 &&
        tap.planned === tap.results.length,
      exitCode,
      tap,
      detail: options.detail ?? 'psql exit 0',
    };
  };

  const mutated = (
    file: string,
    options: Parameters<typeof run>[1] & { applied?: boolean } = {}
  ) => ({ ...run(file, options), mutationApplied: options.applied ?? true });

  const catching = (file: string) => ({
    file,
    mutated: mutated(file, { failing: [2] }),
    rerun: run(file),
  });

  const suite = (parts: {
    files: string[];
    clean: TestFileRun[];
    catches?: Array<ReturnType<typeof catching>>;
  }): SuiteProbe => ({ ok: true, catches: [], ...parts });

  const failedSuite: SuiteProbe = {
    ok: false,
    notes: 'managed: exit 1: no stack running',
  };

  describe('checkTestsPass', () => {
    it('passes when every file passes and there are tests', () => {
      expect(
        checkTestsPass(suite({ files: [A], clean: [run(A)] }))
      ).toMatchObject({ name: TESTS_PASS_CHECK_NAME, passed: true });
    });

    it('passes several files that all pass', () => {
      expect(
        checkTestsPass(suite({ files: [A, B], clean: [run(A), run(B)] })).passed
      ).toBe(true);
    });

    it('passes a skipped file next to a file with tests', () => {
      const skipped = run(B, { descriptions: [], planned: 0 });
      expect(
        checkTestsPass(suite({ files: [A, B], clean: [run(A), skipped] }))
          .passed
      ).toBe(true);
    });

    it('fails with a note naming supabase/tests when there are no test files', () => {
      const check = checkTestsPass(suite({ files: [], clean: [] }));
      expect(check.name).toBe(TESTS_PASS_CHECK_NAME);
      expect(check.passed).toBe(false);
      expect(check.notes).toContain('supabase/tests');
    });

    it('fails when only one of two files fails, naming it and its first failing test', () => {
      const failing = run(B, { failing: [2, 3] });
      const check = checkTestsPass(
        suite({ files: [A, B], clean: [run(A), failing] })
      );
      expect(check.passed).toBe(false);
      expect(check.notes).toContain(B);
      expect(check.notes).toContain(D2);
    });

    it('fails a file that died before finishing, naming it and its detail', () => {
      const died = run(A, {
        descriptions: [D1],
        failing: [],
        planned: 3,
        exitCode: 3,
        detail: 'psql exit 3: ERROR:  more than one row returned by a subquery',
      });
      const check = checkTestsPass(suite({ files: [A], clean: [died] }));
      expect(check.passed).toBe(false);
      expect(check.notes).toContain(A);
      expect(check.notes).toContain('more than one row returned by a subquery');
    });

    it('fails a file that planned more tests than it ran', () => {
      const short = run(A, {
        descriptions: [D1],
        planned: 3,
        detail: 'planned 3 tests but ran 1',
      });
      const check = checkTestsPass(suite({ files: [A], clean: [short] }));
      expect(check.passed).toBe(false);
      expect(check.notes).toContain('planned 3 tests but ran 1');
    });

    it('fails when the files hold no tests at all', () => {
      const empty = run(A, { descriptions: [], planned: 0 });
      const check = checkTestsPass(suite({ files: [A], clean: [empty] }));
      expect(check.passed).toBe(false);
      expect(check.notes).toMatch(/no tests|zero tests|0 tests/i);
    });

    it('fails with the suite notes when the suite could not run', () => {
      const check = checkTestsPass(failedSuite);
      expect(check.name).toBe(TESTS_PASS_CHECK_NAME);
      expect(check.passed).toBe(false);
      expect(check.notes).toContain('no stack running');
    });
  });

  describe('checkTestsCatchSeededPolicies', () => {
    it('passes when a file passed clean, failed under the mutation with the marker, and passed the re-run', () => {
      const check = checkTestsCatchSeededPolicies(
        suite({ files: [A], clean: [run(A)], catches: [catching(A)] })
      );
      expect(check).toMatchObject({
        name: TESTS_CATCH_CHECK_NAME,
        passed: true,
      });
      expect(check.notes).toContain(A);
      expect(check.notes).toContain(D2);
    });

    it('passes when one of two files catches the policies', () => {
      const notCaught = {
        file: B,
        mutated: mutated(B),
        rerun: run(B),
      };
      expect(
        checkTestsCatchSeededPolicies(
          suite({
            files: [A, B],
            clean: [run(A), run(B)],
            catches: [notCaught, catching(A)],
          })
        ).passed
      ).toBe(true);
    });

    it('passes when a catching file sits next to a file that failed clean', () => {
      expect(
        checkTestsCatchSeededPolicies(
          suite({
            files: [A, B],
            clean: [run(A), run(B, { failing: [1] })],
            catches: [catching(A)],
          })
        ).passed
      ).toBe(true);
    });

    it('fails when the mutation failed the tests but its marker never printed', () => {
      const check = checkTestsCatchSeededPolicies(
        suite({
          files: [A],
          clean: [run(A)],
          catches: [
            {
              file: A,
              mutated: mutated(A, {
                descriptions: [],
                planned: null,
                exitCode: 2,
                applied: false,
              }),
              rerun: run(A),
            },
          ],
        })
      );
      expect(check.passed).toBe(false);
      expect(check.notes).toMatch(
        /mutation (did not|didn't) apply|mutation was not applied|not applied/i
      );
    });

    it('fails when a failing mutated run has no marker even though the tap shows failures', () => {
      const check = checkTestsCatchSeededPolicies(
        suite({
          files: [A],
          clean: [run(A)],
          catches: [
            {
              file: A,
              mutated: mutated(A, { failing: [2], applied: false }),
              rerun: run(A),
            },
          ],
        })
      );
      expect(check.passed).toBe(false);
    });

    it('fails when the tests still pass under the mutation', () => {
      const check = checkTestsCatchSeededPolicies(
        suite({
          files: [A],
          clean: [run(A)],
          catches: [{ file: A, mutated: mutated(A), rerun: run(A) }],
        })
      );
      expect(check.name).toBe(TESTS_CATCH_CHECK_NAME);
      expect(check.passed).toBe(false);
      expect(check.notes).toContain(A);
      expect(check.notes).toMatch(/pass/i);
    });

    it('fails when the re-run fails, since the failure may be state drift rather than the policies', () => {
      const check = checkTestsCatchSeededPolicies(
        suite({
          files: [A],
          clean: [run(A)],
          catches: [
            {
              file: A,
              mutated: mutated(A, { failing: [2] }),
              rerun: run(A, { failing: [3] }),
            },
          ],
        })
      );
      expect(check.passed).toBe(false);
      expect(check.notes).toMatch(/re-?run/i);
    });

    it('fails when the clean run fails, since a failing suite cannot prove it catches anything', () => {
      const check = checkTestsCatchSeededPolicies(
        suite({ files: [A], clean: [run(A, { failing: [2] })] })
      );
      expect(check.name).toBe(TESTS_CATCH_CHECK_NAME);
      expect(check.passed).toBe(false);
      expect(check.notes).toMatch(/fail/i);
    });

    it('fails when there are no test files', () => {
      expect(
        checkTestsCatchSeededPolicies(suite({ files: [], clean: [] })).passed
      ).toBe(false);
    });

    it('fails with the suite notes when the suite could not run', () => {
      const check = checkTestsCatchSeededPolicies(failedSuite);
      expect(check.name).toBe(TESTS_CATCH_CHECK_NAME);
      expect(check.passed).toBe(false);
      expect(check.notes).toContain('no stack running');
    });
  });
});
