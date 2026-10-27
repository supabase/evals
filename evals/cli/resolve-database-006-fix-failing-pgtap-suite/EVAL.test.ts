// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-006-fix-failing-pgtap-suite
import type {
  CheckResult,
  CommandResult,
  JudgeInput,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
  ToolCallRecord,
  TranscriptPart,
} from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import { formatDetourJudgeInput } from '../lib/detours.js';
import { shellQuote } from '../lib/shell.js';
import scorer from './EVAL.js';
import {
  readSeedFile,
  SEEDED_MIGRATIONS,
  SEEDED_TEST_FILES,
  SEEDED_TESTS,
} from './fixtures.js';
import { REPORT_RUBRIC } from './report.js';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const REPLAY_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/eval_replay';

const MARKER: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'beta',
  cliVersion: '2.0.0',
  docker: 'available',
  sessionStartedMs: 1_000,
};

const [CREATE_FILE, DISCOUNTS_FILE] = SEEDED_MIGRATIONS;
const [TOTALS_TEST, DISCOUNTS_TEST] = SEEDED_TEST_FILES;
const FIX_FILE = '20260302000000_fix_discounts.sql';
const EARLY_FIX_FILE = '20260201000000_fix_discounts.sql';
const EMPTY_NAME_FIX_FILE = '20261026000000_.sql';

const replaceOnce = (text: string, from: string, to: string) => {
  if (!text.includes(from)) throw new Error(`seed no longer contains ${from}`);
  return text.replace(from, to);
};

const SEEDED_FILES: Record<string, string> = Object.fromEntries(
  SEEDED_MIGRATIONS.map((name) => [
    name,
    readSeedFile(`supabase/migrations/${name}`),
  ])
);
const SEEDED_TEST_SQL: Record<string, string> = Object.fromEntries(
  SEEDED_TESTS.map(({ file, sql }) => [file, sql])
);

const ADD_DEFAULT = (sql: string) =>
  replaceOnce(sql, 'integer not null\n', 'integer not null default 0\n');
const FIX_TOTAL = (sql: string, discount = 'l.discount_percent') =>
  replaceOnce(
    sql,
    'l.unit_price_cents * l.discount_percent / 100',
    `l.unit_price_cents * (100 - ${discount}) / 100`
  );

const FIXED_DISCOUNTS = FIX_TOTAL(ADD_DEFAULT(SEEDED_FILES[DISCOUNTS_FILE]));
const DEFAULT_ONLY_DISCOUNTS = ADD_DEFAULT(SEEDED_FILES[DISCOUNTS_FILE]);
const NULLABLE_DISCOUNTS = FIX_TOTAL(
  replaceOnce(SEEDED_FILES[DISCOUNTS_FILE], 'integer not null\n', 'integer\n'),
  'coalesce(l.discount_percent, 0)'
);
const FIX_FUNCTION_SQL = `create or replace function public.invoice_total_cents(p_invoice_id bigint)
returns bigint
language sql
stable
as $$
  select coalesce(sum(l.quantity * l.unit_price_cents * (100 - l.discount_percent) / 100), 0)::bigint
  from public.invoice_lines l
  where l.invoice_id = p_invoice_id;
$$;
`;
const FIX_SQL = `alter table public.invoice_lines alter column discount_percent set default 0;

${FIX_FUNCTION_SQL}`;
const BROKEN_SQL = 'this is not sql;\n';

const FIXED_IN_PLACE: Record<string, string> = {
  ...SEEDED_FILES,
  [DISCOUNTS_FILE]: FIXED_DISCOUNTS,
};
const WITH_FIX_MIGRATION: Record<string, string> = {
  ...SEEDED_FILES,
  [FIX_FILE]: FIX_SQL,
};

type Behaviour = { insertOk: boolean; totalOk: boolean };

// Derives what a database does from the statements applied to it, in order.
function behaviourOf(sqls: readonly string[]): Behaviour {
  let insertOk = false;
  let totalOk = false;
  for (const raw of sqls) {
    const sql = raw.replace(/^\s*--.*$/gm, '');
    const add = sql.match(/add column discount_percent[^;]*/i)?.[0];
    if (add !== undefined) {
      insertOk = /\bdefault\b/i.test(add) || !/\bnot null\b/i.test(add);
    }
    if (
      /alter column discount_percent (?:set default|drop not null)/i.test(sql)
    ) {
      insertOk = true;
    }
    const fn = sql.match(
      /function public\.invoice_total_cents[\s\S]*?\$\$;/i
    )?.[0];
    if (fn !== undefined) totalOk = /\(100 - /.test(fn);
  }
  return { insertOk, totalOk };
}

const behaviourOfFiles = (files: Record<string, string>) =>
  behaviourOf(
    Object.keys(files)
      .sort()
      .map((name) => files[name])
  );

type Entry = { ok: boolean; description: string; have?: string; want?: string };

const tapOf = (planned: number, entries: Entry[]) =>
  `${[
    `1..${planned}`,
    ...entries.flatMap(({ ok, description, have, want }, index) => [
      `${ok ? 'ok' : 'not ok'} ${index + 1} - ${description}`,
      ...(ok
        ? []
        : [
            `# Failed test ${index + 1}: "${description}"`,
            `#         have: ${have}`,
            `#         want: ${want}`,
          ]),
    ]),
  ].join('\n')}\n`;

const TOTALS_DESCRIPTIONS = [
  'Function public.invoice_total_cents(bigint) should exist',
  'an invoice total is the sum of quantity times unit price',
  'an invoice with no lines totals zero',
  'a line needs a positive quantity',
];
const DISCOUNTS_DESCRIPTIONS = [
  'invoice lines have a discount column',
  'a 10% discount takes 10% off the line',
  'discounted and full-price lines add up',
  'a 100% discount makes the line free',
  'a discount cannot be more than 100%',
];

function totalsRun({ insertOk, totalOk }: Behaviour): CommandResult {
  const [exists, sum, empty, positive] = TOTALS_DESCRIPTIONS;
  if (!insertOk) {
    return {
      ok: false,
      exitCode: 3,
      stdout: tapOf(4, [{ ok: true, description: exists }]),
      stderr:
        'psql:<stdin>:12: ERROR:  null value in column "discount_percent" of relation "invoice_lines" violates not-null constraint\nDETAIL:  Failing row contains (1, 900001, Consulting hours, 2, 1500, null).\n',
    };
  }
  return {
    ok: true,
    exitCode: 0,
    stdout: tapOf(4, [
      { ok: true, description: exists },
      { ok: totalOk, description: sum, have: '0', want: '5500' },
      { ok: true, description: empty },
      { ok: true, description: positive },
    ]),
    stderr: '',
  };
}

function discountsRun({ totalOk }: Behaviour): CommandResult {
  const [column, tenPercent, mixed, free, capped] = DISCOUNTS_DESCRIPTIONS;
  return {
    ok: true,
    exitCode: 0,
    stdout: tapOf(5, [
      { ok: true, description: column },
      { ok: totalOk, description: tenPercent, have: '300', want: '2700' },
      { ok: totalOk, description: mixed, have: '1000', want: '4000' },
      { ok: totalOk, description: free, have: '2100', want: '0' },
      { ok: true, description: capped },
    ]),
    stderr: '',
  };
}

const unquote = (text: string) =>
  text.startsWith("'") ? text.slice(1, -1).replaceAll("'\\''", "'") : text;

const result = (
  stdout: string,
  ok = true,
  stderr = '',
  exitCode = ok ? 0 : 1
): CommandResult => ({ ok, exitCode, stdout, stderr });

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

function call(command: string, output = ''): ToolCallRecord {
  return {
    tool: { kind: 'other', toolName: 'shell' },
    body: { command },
    command,
    result: output,
    ts: 0,
  };
}

const errored = (command: string, error: string): ToolCallRecord => {
  const { result: _result, ...record } = call(command);
  return { ...record, error };
};

type HistoryRow = { version: string; statements: string[] | null };

type World = {
  stack?: 'up' | 'down';
  ready?: boolean;
  files?: Record<string, string>;
  applied?: Record<string, string>;
  live?: Behaviour;
  tests?: Record<string, string> | null;
  pgtap?: boolean;
  history?: 'unreadable';
  extraHistory?: HistoryRow[];
  listFails?: boolean;
  judge?: (args: JudgeInput) => Promise<{ passed: boolean; notes?: string }>;
  transcript?: TranscriptPart[];
  markerThrows?: boolean;
  execThrows?: boolean;
};

function fakeCtx(toolCalls: ToolCallRecord[], world: World = {}) {
  const stack = world.stack ?? 'up';
  const files = world.files ?? FIXED_IN_PLACE;
  const applied = world.applied ?? files;
  const live = world.live ?? behaviourOfFiles(applied);
  const tests = world.tests === undefined ? SEEDED_TEST_SQL : world.tests;
  const judge = vi.fn(
    world.judge ?? (async () => ({ passed: true, notes: 'ok' }))
  );
  const commands: string[] = [];
  const log: string[] = [];
  const scripts: string[] = [];
  const dbs = {
    live: { pgtap: world.pgtap ?? false },
    replay: { exists: false, pgtap: false, applied: [] as string[] },
  };

  const runScript = (command: string, target: 'live' | 'replay') => {
    const encoded =
      /printf\s+'?%s'?\s+'?([A-Za-z0-9+/=]+)'?\s*\|\s*base64 -d/.exec(
        command
      )?.[1];
    const script = Buffer.from(encoded ?? '', 'base64').toString('utf8');
    scripts.push(script);
    const test = SEEDED_TESTS.find(({ sql }) => sql === script);
    if (test === undefined) {
      return result('', false, 'psql:<stdin>:1: ERROR:  unexpected script', 3);
    }
    log.push(`run ${test.file} on ${target}`);
    const behaviour =
      target === 'live'
        ? live
        : behaviourOf(dbs.replay.applied.map((name) => files[name]));
    return test.file === TOTALS_TEST
      ? totalsRun(behaviour)
      : discountsRun(behaviour);
  };

  const applyMigrations = (command: string) => {
    const paths = [...command.matchAll(/\s-f\s+('(?:[^']|'\\'')*'|\S+)/g)].map(
      ([, path]) => unquote(path)
    );
    for (const path of paths) {
      const name = path.replace(/^supabase\/migrations\//, '');
      if (!(name in files)) {
        return result(
          '',
          false,
          `psql: error: ${path}: No such file or directory`,
          1
        );
      }
      if (files[name] === BROKEN_SQL) {
        return result(
          '',
          false,
          `psql:${path}:1: ERROR:  syntax error at or near "this"`,
          3
        );
      }
      dbs.replay.applied.push(name);
    }
    log.push(`apply ${dbs.replay.applied.join(',')}`);
    return result('');
  };

  const psql = (command: string): CommandResult => {
    const target = command.includes(shellQuote(DB_URL))
      ? 'live'
      : command.includes(shellQuote(REPLAY_URL))
        ? 'replay'
        : undefined;
    if (stack !== 'up' || target === undefined) {
      return result('', false, 'psql: error: connection refused', 2);
    }
    if (/-tAc 'select 1'\s*$/.test(command)) {
      return world.ready === false
        ? result('', false, 'psql: error: connection refused', 2)
        : result('1\n');
    }
    if (target === 'live' && /drop database/i.test(command)) {
      if (!/drop database if exists eval_replay\b/i.test(command)) {
        return result('', false, 'psql: error: refusing to drop that', 3);
      }
      dbs.replay = { exists: false, pgtap: false, applied: [] };
      log.push('drop-replay');
      if (/create database eval_replay\b/i.test(command)) {
        dbs.replay.exists = true;
        log.push('create-replay');
      }
      return result('');
    }
    if (target === 'live' && command.includes('schema_migrations')) {
      if (world.history === 'unreadable') {
        return result(
          '',
          false,
          'psql:<stdin>:1: ERROR:  relation "supabase_migrations.schema_migrations" does not exist',
          3
        );
      }
      const rows: HistoryRow[] = [
        ...Object.keys(applied)
          .sort()
          .map((name) => ({
            version: name.slice(0, 14),
            statements: statementsOf(applied[name]),
          })),
        ...(world.extraHistory ?? []),
      ];
      return result(
        `[${rows.map((row) => JSON.stringify(row)).join(', \n ')}]\n`
      );
    }
    if (target === 'replay' && !dbs.replay.exists) {
      return result(
        '',
        false,
        'psql: error: connection to server failed: FATAL:  database "eval_replay" does not exist',
        2
      );
    }
    const state = target === 'live' ? dbs.live : dbs.replay;
    if (command.includes('pg_extension')) {
      return result(state.pgtap ? 't\n' : 'f\n');
    }
    if (/create extension/i.test(command)) {
      state.pgtap = true;
      log.push(`create-pgtap on ${target}`);
      return result('');
    }
    if (/drop extension/i.test(command)) {
      state.pgtap = false;
      log.push(`drop-pgtap on ${target}`);
      return result('');
    }
    if (command.includes('base64 -d')) return runScript(command, target);
    if (target === 'replay' && /\s-f\s/.test(command)) {
      return applyMigrations(command);
    }
    if (/create schema if not exists extensions/i.test(command)) {
      return result('');
    }
    return result('', false, `unexpected psql command: ${command}`, 1);
  };

  const exec = async (command: string): Promise<CommandResult> => {
    commands.push(command);
    if (world.execThrows) throw new Error('sandbox gone');
    if (command.endsWith('supabase --version')) return result('2.0.0\n');
    if (command.includes('supabase stack status')) {
      if (stack === 'down') return result('', false, 'no stack running');
      return command.includes('--env')
        ? result(JSON.stringify({ DB_URL }))
        : result(JSON.stringify({ runtime: 'native' }));
    }
    if (/supabase (stack list|status)/.test(command)) {
      return result('', false, 'no stack running');
    }
    if (/^psql\b/.test(command) || command.includes('| psql ')) {
      return psql(command);
    }
    if (/^ls\b/.test(command) && command.includes('supabase/migrations')) {
      return world.listFails
        ? result('', false, 'ls: cannot access supabase/migrations', 2)
        : result(Object.keys(files).sort().join('\n'));
    }
    if (/^find\b/.test(command) && command.includes('supabase/tests')) {
      if (tests === null) {
        return result(
          '',
          false,
          "find: 'supabase/tests': No such file or directory"
        );
      }
      const relative = /-printf\s+'?%P/.test(command);
      return result(
        Object.keys(tests)
          .map((name) => (relative ? name : `supabase/tests/${name}`))
          .join('\n')
      );
    }
    const cat = /^cat\s+(.+?)\s*$/.exec(command);
    if (cat) {
      const path = unquote(cat[1]);
      const migration = path.match(/^supabase\/migrations\/(.+)$/)?.[1];
      if (migration !== undefined) {
        return migration in files
          ? result(files[migration])
          : result('', false, `cat: ${path}: No such file or directory`);
      }
      const test = path.match(/^supabase\/tests\/(.+)$/)?.[1];
      if (test !== undefined) {
        return tests !== null && test in tests
          ? result(tests[test])
          : result('', false, `cat: ${path}: No such file or directory`);
      }
    }
    return result('', false, `unexpected command: ${command}`);
  };

  const ctx = {
    workspace: '/ws',
    exec,
    toolCalls,
    transcript: world.transcript ?? [],
    environmentMarker: async () => {
      if (world.markerThrows) throw new Error('marker unreadable');
      return MARKER;
    },
    judge,
  } as unknown as LocalStackEvalContext;
  return { ctx, judge, commands, log, scripts, dbs };
}

const CHECK_NAMES = [
  'local stack is running for this project',
  'the whole suite passed under supabase test db',
  'the seeded tests pass against the local database',
  'the seeded tests pass on a database rebuilt from the migrations',
  'the migration history matches the migration files',
  'the seeded tests were left as they were',
  'no container-runtime detours',
  'metrics',
  'final report is truthful about the tests and the fix',
];

const [
  STACK,
  TEST_DB,
  LIVE,
  REPLAY,
  HISTORY,
  UNCHANGED,
  DETOURS,
  METRICS,
  REPORT,
] = CHECK_NAMES;

const SCORER_FAILED =
  'scorer evaluated resolve-database-006-fix-failing-pgtap-suite';

const PASS_OUTPUT = `supabase/tests/invoice_totals.test.sql .. ok
supabase/tests/line_discounts.test.sql .. ok
All tests successful.
Files=2, Tests=9,  0 wallclock secs ( 0.01 usr  0.00 sys +  0.03 cusr  0.01 csys =  0.05 CPU)
Result: PASS
`;
const EXTRA_FILE_PASS_OUTPUT = `supabase/tests/invoice_totals.test.sql .. ok
supabase/tests/line_discounts.test.sql .. ok
supabase/tests/rounding.test.sql .. ok
All tests successful.
Files=3, Tests=11,  0 wallclock secs ( 0.01 usr  0.00 sys +  0.03 cusr  0.01 csys =  0.05 CPU)
Result: PASS
`;
const FAIL_OUTPUT = `supabase/tests/invoice_totals.test.sql ..
Dubious, test returned 3 (wstat 768, 0x300)
supabase/tests/line_discounts.test.sql ..
Failed 3/5 subtests

Test Summary Report
-------------------
Files=2, Tests=6,  0 wallclock secs ( 0.01 usr  0.00 sys +  0.03 cusr  0.01 csys =  0.05 CPU)
Result: FAIL
error running container: exit 1
`;

const EXTRA_ASSERTION_PASS_OUTPUT = PASS_OUTPUT.replace('Tests=9', 'Tests=10');
const SINGLE_FILE_PASS_OUTPUT =
  'supabase/tests/rounding.test.sql .. ok\nAll tests successful.\nFiles=1, Tests=2,  0 wallclock secs\nResult: PASS\n';
const SINGLE_FILE_FAIL_OUTPUT =
  'supabase/tests/rounding.test.sql ..\nFailed 1/2 subtests\nFiles=1, Tests=2,  0 wallclock secs\nResult: FAIL\nerror running container: exit 1\n';

const START = call('supabase start');
const WRITE_FIX = call(
  `cat > supabase/migrations/${FIX_FILE} <<'EOF'\n${FIX_SQL}EOF`
);
const EDIT_MIGRATION = call(
  `sed -i 's/integer not null$/integer not null default 0/' supabase/migrations/${DISCOUNTS_FILE}`
);
const RESET = call('supabase db reset');
const MIGRATION_UP = call('supabase migration up');
const TEST_DB_PASS = call('supabase test db', PASS_OUTPUT);
const TEST_DB_FAIL = errored('supabase test db', FAIL_OUTPUT);

const IN_PLACE_RUN = [START, EDIT_MIGRATION, RESET, TEST_DB_PASS];
const FIX_MIGRATION_RUN = [START, WRITE_FIX, MIGRATION_UP, TEST_DB_PASS];

async function score(toolCalls: ToolCallRecord[], world: World = {}) {
  const fake = fakeCtx(toolCalls, world);
  const scored = await scorer(fake.ctx);
  const checks: CheckResult[] = scored.checks ?? [];
  return {
    ...fake,
    scored,
    checks,
    failed: checks.filter(({ passed }) => !passed).map(({ name }) => name),
    check: (name: string) => checks.find((entry) => entry.name === name),
  };
}

const judgeCalls = (judge: ReturnType<typeof fakeCtx>['judge']) =>
  judge.mock.calls.map(([args]) => args);
const reportCall = (judge: ReturnType<typeof fakeCtx>['judge']) =>
  judgeCalls(judge).find(({ rubric }) => rubric === REPORT_RUBRIC);
const detourCall = (judge: ReturnType<typeof fakeCtx>['judge']) =>
  judgeCalls(judge).find(({ rubric }) => rubric !== REPORT_RUBRIC);

describe('the fake database', () => {
  it('expects the descriptions the seeded tests assert', () => {
    for (const description of TOTALS_DESCRIPTIONS.slice(1)) {
      expect(SEEDED_TEST_SQL[TOTALS_TEST]).toContain(description);
    }
    for (const description of DISCOUNTS_DESCRIPTIONS) {
      expect(SEEDED_TEST_SQL[DISCOUNTS_TEST]).toContain(description);
    }
  });

  it.each([
    [
      'the seeded migrations',
      SEEDED_FILES,
      { insertOk: false, totalOk: false },
    ],
    [
      'only the default fixed',
      { ...SEEDED_FILES, [DISCOUNTS_FILE]: DEFAULT_ONLY_DISCOUNTS },
      { insertOk: true, totalOk: false },
    ],
    ['the in-place fix', FIXED_IN_PLACE, { insertOk: true, totalOk: true }],
    ['a fix migration', WITH_FIX_MIGRATION, { insertOk: true, totalOk: true }],
    [
      'a nullable column and coalesce',
      { ...SEEDED_FILES, [DISCOUNTS_FILE]: NULLABLE_DISCOUNTS },
      { insertOk: true, totalOk: true },
    ],
    [
      'a fix that sorts before the buggy migration',
      { ...SEEDED_FILES, [EARLY_FIX_FILE]: FIX_FUNCTION_SQL },
      { insertOk: false, totalOk: false },
    ],
  ])('models %s', (_label, files, expected) => {
    expect(behaviourOfFiles(files)).toEqual(expected);
  });
});

describe('valid fixes pass every check', () => {
  it('passes an in-place fix applied by db reset and confirmed by supabase test db, reporting the nine checks in the declared order', async () => {
    const { scored, checks } = await score(IN_PLACE_RUN);
    expect(checks.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(checks.filter(({ passed }) => !passed)).toEqual([]);
    expect(scored.passed).toBe(true);
  });

  it('passes a new fix migration applied with migration up', async () => {
    const { checks, scored } = await score(FIX_MIGRATION_RUN, {
      files: WITH_FIX_MIGRATION,
    });
    expect(checks.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(checks.filter(({ passed }) => !passed)).toEqual([]);
    expect(scored.passed).toBe(true);
  });

  it('passes a fix migration with an empty name part applied with migration up', async () => {
    const files = { ...SEEDED_FILES, [EMPTY_NAME_FIX_FILE]: FIX_SQL };
    const { failed, check } = await score(
      [
        START,
        call(
          `cat > supabase/migrations/${EMPTY_NAME_FIX_FILE} <<'EOF'\n${FIX_SQL}EOF`
        ),
        MIGRATION_UP,
        TEST_DB_PASS,
      ],
      { files }
    );
    expect(failed).toEqual([]);
    expect(check(HISTORY)?.notes).toBe(
      '3 migration files recorded as they are now'
    );
  });

  it('passes an in-place fix beside an abandoned empty migration recorded with no statements', async () => {
    const files = {
      ...FIXED_IN_PLACE,
      '20260301120000_abandoned.sql': '',
    };
    const { failed, check } = await score(
      [
        START,
        call('supabase migration new abandoned'),
        ...IN_PLACE_RUN.slice(1),
      ],
      { files }
    );
    expect(failed).toEqual([]);
    expect(check(HISTORY)?.notes).toBe(
      '3 migration files recorded as they are now'
    );
  });

  it('passes a fix that makes the column nullable and coalesces it in the function', async () => {
    const files = { ...SEEDED_FILES, [DISCOUNTS_FILE]: NULLABLE_DISCOUNTS };
    const { failed } = await score(IN_PLACE_RUN, { files });
    expect(failed).toEqual([]);
  });

  it('passes a fix that also adds a test file and comments in the seeded tests', async () => {
    const commented = Object.fromEntries(
      SEEDED_TEST_FILES.map((file) => [
        file,
        `-- reviewed by hand\n${SEEDED_TEST_SQL[file]}\n\n-- end\n`,
      ])
    );
    const { failed, check } = await score(
      [
        START,
        EDIT_MIGRATION,
        RESET,
        call('supabase test db', EXTRA_FILE_PASS_OUTPUT),
      ],
      {
        tests: {
          ...commented,
          'rounding.test.sql':
            'begin;\nselect plan(1);\nselect pass();\nselect * from finish();\nrollback;\n',
        },
      }
    );
    expect(failed).toEqual([]);
    expect(check(UNCHANGED)?.notes).toBe('2 seeded test files unchanged');
    expect(check(TEST_DB)?.notes).toBe(
      'command 4 printed Result: PASS (Files=3, Tests=11)'
    );
  });

  it('passes a fix that adds an assertion to a seeded test and raises its plan to match', async () => {
    const extended = replaceOnce(
      replaceOnce(
        SEEDED_TEST_SQL[DISCOUNTS_TEST],
        'select plan(5);',
        'select plan(6);'
      ),
      'select * from finish();',
      `select is(
  public.invoice_total_cents(900101),
  2700::bigint,
  'the 10% line still totals 2700'
);

select * from finish();`
    );
    const { failed, check } = await score(
      [
        START,
        EDIT_MIGRATION,
        RESET,
        call('supabase test db', EXTRA_ASSERTION_PASS_OUTPUT),
      ],
      { tests: { ...SEEDED_TEST_SQL, [DISCOUNTS_TEST]: extended } }
    );
    expect(failed).toEqual([]);
    expect(check(UNCHANGED)?.notes).toBe(
      `2 seeded test files unchanged; added to ${DISCOUNTS_TEST}: 1 statement`
    );
    expect(check(TEST_DB)?.notes).toBe(
      'command 4 printed Result: PASS (Files=2, Tests=10)'
    );
  });

  it('passes when a single-file re-run of the passing suite came last', async () => {
    const singleFile = call(
      'supabase test db supabase/tests/line_discounts.test.sql',
      'supabase/tests/line_discounts.test.sql .. ok\nAll tests successful.\nFiles=1, Tests=5,  0 wallclock secs\nResult: PASS\n'
    );
    const { failed } = await score([...IN_PLACE_RUN, singleFile]);
    expect(failed).toEqual([]);
  });

  it.each([
    [
      'grep',
      "supabase db reset && supabase test db 2>&1 | grep -E 'Result|not ok'",
    ],
    ['tail', 'supabase test db | tail -n 1'],
    ['npx and tail', 'npx supabase test db | tail -1'],
    ['a flag and tail', 'supabase test db --debug | tail -1'],
  ])(
    'passes when the whole-directory run was filtered down to its result line with %s',
    async (_label, command) => {
      const { failed, check } = await score([
        START,
        EDIT_MIGRATION,
        RESET,
        call(command, 'Result: PASS\n'),
      ]);
      expect(failed).toEqual([]);
      expect(check(TEST_DB)?.notes).toBe('command 4 printed Result: PASS');
    }
  );

  it('passes when a failing run of a single test file the agent added, and its passing re-run, came after the whole-suite pass', async () => {
    const own = 'supabase test db supabase/tests/rounding.test.sql';
    const { failed, check } = await score([
      ...IN_PLACE_RUN,
      errored(own, SINGLE_FILE_FAIL_OUTPUT),
      EDIT_MIGRATION,
      call(own, SINGLE_FILE_PASS_OUTPUT),
    ]);
    expect(failed).toEqual([]);
    expect(check(TEST_DB)?.notes).toBe(
      'command 4 printed Result: PASS (Files=2, Tests=9)'
    );
  });

  it('passes the agent that re-ran supabase start on the already running stack before an in-place fix and db reset', async () => {
    const { failed, scored } = await score([
      START,
      EDIT_MIGRATION,
      RESET,
      TEST_DB_PASS,
    ]);
    expect(failed).toEqual([]);
    expect(scored.passed).toBe(true);
  });

  it('passes the agent that stopped with --no-backup and started again after an in-place edit, since the start rebuilds the database from the files', async () => {
    const { failed, scored, check } = await score([
      EDIT_MIGRATION,
      call('supabase stop --no-backup'),
      START,
      TEST_DB_PASS,
    ]);
    expect(failed).toEqual([]);
    expect(scored.passed).toBe(true);
    expect(check(HISTORY)?.notes).toBe(
      '2 migration files recorded as they are now'
    );
  });

  it('passes the iterate-to-green loop on the pre-started stack: a red test db, an in-place fix, db reset and a green test db', async () => {
    const { checks, scored, check } = await score([
      TEST_DB_FAIL,
      EDIT_MIGRATION,
      RESET,
      TEST_DB_PASS,
    ]);
    expect(checks.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(checks.filter(({ passed }) => !passed)).toEqual([]);
    expect(scored.passed).toBe(true);
    expect(check(TEST_DB)?.notes).toBe(
      'command 4 printed Result: PASS (Files=2, Tests=9)'
    );
    expect(JSON.parse(check(METRICS)?.notes ?? '{}')).toMatchObject({
      testDbResults: ['FAIL', 'PASS'],
      testDbFailedFirst: true,
      resetRuns: 1,
    });
  });

  it('reports what the harness ran in the notes of each probed check', async () => {
    const { check } = await score(IN_PLACE_RUN);
    expect(check(STACK)?.notes).toContain('select 1 ok');
    expect(check(TEST_DB)?.notes).toBe(
      'command 4 printed Result: PASS (Files=2, Tests=9)'
    );
    expect(check(LIVE)?.notes).toContain(`${TOTALS_TEST}: 4/4 passed`);
    expect(check(LIVE)?.notes).toContain(`${DISCOUNTS_TEST}: 5/5 passed`);
    expect(check(REPLAY)?.notes).toContain('2 migration(s) replayed');
    expect(check(HISTORY)?.notes).toBe(
      '2 migration files recorded as they are now'
    );
    expect(check(UNCHANGED)?.notes).toBe('2 seeded test files unchanged');
  });
});

describe('known-bad runs fail on the right check', () => {
  const buggyNumbers = (sql: string) =>
    replaceOnce(
      replaceOnce(
        replaceOnce(sql, '2700::bigint', '300::bigint'),
        '4000::bigint',
        '1000::bigint'
      ),
      "0::bigint,\n  'a 100% discount",
      "2100::bigint,\n  'a 100% discount"
    );

  it('fails the agent that edited the tests to expect the buggy totals, while the pristine tests still fail the database', async () => {
    const { failed, check, scripts } = await score(
      [START, call('supabase test db', PASS_OUTPUT)],
      {
        files: SEEDED_FILES,
        tests: {
          ...SEEDED_TEST_SQL,
          [DISCOUNTS_TEST]: buggyNumbers(SEEDED_TEST_SQL[DISCOUNTS_TEST]),
        },
      }
    );
    expect(failed).toEqual([LIVE, REPLAY, UNCHANGED]);
    expect(check(UNCHANGED)?.notes).toBe(`modified: ${DISCOUNTS_TEST}`);
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(Object.values(SEEDED_TEST_SQL)).toContain(script);
    }
  });

  it('fails the agent that fixed the migration, reset, and marked the discount totals as todo, on the unchanged-tests check alone', async () => {
    const masked = replaceOnce(
      SEEDED_TEST_SQL[DISCOUNTS_TEST],
      'select is(',
      "select todo('discount maths under review', 3);\n\nselect is("
    );
    const { failed, check } = await score(IN_PLACE_RUN, {
      tests: { ...SEEDED_TEST_SQL, [DISCOUNTS_TEST]: masked },
    });
    expect(failed).toEqual([UNCHANGED]);
    expect(check(UNCHANGED)?.notes).toBe(
      `modified: ${DISCOUNTS_TEST} (added a statement the check doesn't allow: select todo('discount maths under review', 3))`
    );
    expect(check(TEST_DB)?.passed).toBe(true);
  });

  it('fails the agent that hand-patched the live database and left the files untouched, on the replay alone', async () => {
    const { failed, check } = await score(
      [START, call('psql "$DB" -f patch.sql'), TEST_DB_PASS],
      { files: SEEDED_FILES, live: { insertOk: true, totalOk: true } }
    );
    expect(failed).toEqual([REPLAY]);
    expect(check(LIVE)?.passed).toBe(true);
    expect(check(HISTORY)?.passed).toBe(true);
    expect(check(REPLAY)?.notes).toContain(DISCOUNTS_TEST);
  });

  it('fails the agent that fixed the migration file and never applied it, on the live database and the history', async () => {
    const { failed, check } = await score(IN_PLACE_RUN, {
      files: FIXED_IN_PLACE,
      applied: SEEDED_FILES,
    });
    expect(failed).toEqual([LIVE, HISTORY]);
    expect(check(HISTORY)?.notes).toBe(
      `${DISCOUNTS_FILE} was recorded with different statements than the file now holds`
    );
    expect(check(REPLAY)?.passed).toBe(true);
  });

  it('fails the agent that applied a new fix migration with psql, skipping the CLI, on the history alone', async () => {
    const { failed, check } = await score(
      [
        START,
        WRITE_FIX,
        call(`psql "$DB" -f supabase/migrations/${FIX_FILE}`),
        TEST_DB_PASS,
      ],
      {
        files: WITH_FIX_MIGRATION,
        applied: SEEDED_FILES,
        live: { insertOk: true, totalOk: true },
      }
    );
    expect(failed).toEqual([HISTORY]);
    expect(check(HISTORY)?.notes).toContain(
      `${FIX_FILE} is not in the migration history`
    );
  });

  it('fails the agent that deleted a seeded test file, on the unchanged-tests check alone', async () => {
    const { failed, check } = await score(IN_PLACE_RUN, {
      tests: { [TOTALS_TEST]: SEEDED_TEST_SQL[TOTALS_TEST] },
    });
    expect(failed).toEqual([UNCHANGED]);
    expect(check(UNCHANGED)?.notes).toBe(`missing: ${DISCOUNTS_TEST}`);
  });

  it('fails the agent that renamed a seeded test file, on the unchanged-tests check alone', async () => {
    const { failed } = await score(IN_PLACE_RUN, {
      tests: {
        [TOTALS_TEST]: SEEDED_TEST_SQL[TOTALS_TEST],
        'discounts.test.sql': SEEDED_TEST_SQL[DISCOUNTS_TEST],
      },
    });
    expect(failed).toEqual([UNCHANGED]);
  });

  it('fails the agent that removed supabase/tests entirely', async () => {
    const { failed, check } = await score(IN_PLACE_RUN, { tests: null });
    expect(failed).toEqual([UNCHANGED]);
    expect(check(UNCHANGED)?.notes).toContain(TOTALS_TEST);
    expect(check(UNCHANGED)?.notes).toContain(DISCOUNTS_TEST);
  });

  it('fails the agent that fixed only the missing default, on the live database and the replay', async () => {
    const files = { ...SEEDED_FILES, [DISCOUNTS_FILE]: DEFAULT_ONLY_DISCOUNTS };
    const { failed, check } = await score(IN_PLACE_RUN, { files });
    expect(failed).toEqual([LIVE, REPLAY]);
    expect(check(LIVE)?.notes).toContain('(have 0, want 5500)');
    expect(check(LIVE)?.notes).toContain('(have 300, want 2700)');
    expect(check(HISTORY)?.passed).toBe(true);
  });

  it('fails the agent that reset with a wrong fix and then patched the live database by hand, on the replay alone', async () => {
    const wrong = { ...SEEDED_FILES, [DISCOUNTS_FILE]: DEFAULT_ONLY_DISCOUNTS };
    const { failed } = await score(
      [
        START,
        EDIT_MIGRATION,
        RESET,
        call('psql "$DB" -f patch.sql'),
        TEST_DB_PASS,
      ],
      { files: wrong, live: { insertOk: true, totalOk: true } }
    );
    expect(failed).toEqual([REPLAY]);
  });

  it('fails the agent whose fix migration sorts before the buggy one, on the live database and the replay', async () => {
    const files = { ...SEEDED_FILES, [EARLY_FIX_FILE]: FIX_FUNCTION_SQL };
    const { failed, check } = await score(
      [
        START,
        call('supabase migration new fix_discounts'),
        RESET,
        TEST_DB_PASS,
      ],
      { files }
    );
    expect(failed).toEqual([LIVE, REPLAY]);
    expect(check(HISTORY)?.passed).toBe(true);
  });

  it('fails the agent that never ran supabase test db and only used psql and pg_prove by hand', async () => {
    const { failed, check } = await score([
      START,
      EDIT_MIGRATION,
      RESET,
      call(
        'pg_prove -d postgresql://postgres:postgres@127.0.0.1:54322/postgres supabase/tests',
        'Files=2, Tests=9\nResult: PASS\n'
      ),
      call(`psql '${DB_URL}' -f supabase/tests/invoice_totals.test.sql`),
    ]);
    expect(failed).toEqual([TEST_DB]);
    expect(check(TEST_DB)?.notes).toBe('supabase test db was never run');
  });

  it('fails the agent whose supabase test db run also ran pg_prove by hand, since either could have printed the summary', async () => {
    const { failed, check } = await score([
      START,
      EDIT_MIGRATION,
      RESET,
      call('pg_prove -r supabase/tests; supabase test db', PASS_OUTPUT),
    ]);
    expect(failed).toEqual([TEST_DB]);
    expect(check(TEST_DB)?.notes).toContain('also ran pg_prove by hand');
  });

  it('fails the agent whose filtered single-file run printed only a result line, since it does not say how many files ran', async () => {
    const { failed, check } = await score([
      START,
      EDIT_MIGRATION,
      RESET,
      call(
        'supabase test db supabase/tests/line_discounts.test.sql | tail -1',
        'Result: PASS\n'
      ),
    ]);
    expect(failed).toEqual([TEST_DB]);
    expect(check(TEST_DB)?.notes).toBe(
      "command 4 printed Result: PASS without a Files= count, so it can't be credited with the whole suite"
    );
  });

  it('fails the agent whose whole-suite failure after a passing run was followed only by a single-file pass', async () => {
    const { failed, check } = await score([
      ...IN_PLACE_RUN,
      TEST_DB_FAIL,
      call(
        'supabase test db supabase/tests/rounding.test.sql',
        SINGLE_FILE_PASS_OUTPUT
      ),
    ]);
    expect(failed).toEqual([TEST_DB]);
    expect(check(TEST_DB)?.notes).toBe(
      'command 5 printed Result: FAIL after the passing run in command 4'
    );
  });

  it('fails the agent whose last supabase test db run failed after a passing one', async () => {
    const { failed, check } = await score([...IN_PLACE_RUN, TEST_DB_FAIL]);
    expect(failed).toEqual([TEST_DB]);
    expect(check(TEST_DB)?.notes).toBe(
      'command 5 printed Result: FAIL after the passing run in command 4'
    );
  });

  it('fails the agent that edited the seeded migration in place after a red test db and never reset or ran migration up, on the live database and the history', async () => {
    const { failed, check } = await score([TEST_DB_FAIL, EDIT_MIGRATION], {
      files: FIXED_IN_PLACE,
      applied: SEEDED_FILES,
    });
    expect(failed).toEqual([TEST_DB, LIVE, HISTORY]);
    expect(check(LIVE)?.notes).toContain('(have 300, want 2700)');
    expect(check(HISTORY)?.notes).toBe(
      `${DISCOUNTS_FILE} was recorded with different statements than the file now holds`
    );
    expect(check(REPLAY)?.passed).toBe(true);
    expect(JSON.parse(check(METRICS)?.notes ?? '{}')).toMatchObject({
      testDbFailedFirst: true,
      resetRuns: 0,
      migrationUpRuns: 0,
    });
  });

  it('fails the agent that stopped and started again, keeping the volume, after an in-place edit, on the live database and the history', async () => {
    const { failed, check } = await score(
      [EDIT_MIGRATION, call('supabase stop'), START, TEST_DB_FAIL],
      { files: FIXED_IN_PLACE, applied: SEEDED_FILES }
    );
    expect(failed).toEqual([TEST_DB, LIVE, HISTORY]);
    expect(check(LIVE)?.notes).toContain('(have 300, want 2700)');
    expect(check(HISTORY)?.notes).toBe(
      `${DISCOUNTS_FILE} was recorded with different statements than the file now holds`
    );
    expect(check(REPLAY)?.passed).toBe(true);
  });

  it('fails the agent whose only supabase test db run failed', async () => {
    const { failed, check } = await score([START, TEST_DB_FAIL], {
      files: SEEDED_FILES,
    });
    expect(failed).toEqual([TEST_DB, LIVE, REPLAY]);
    expect(check(TEST_DB)?.notes).toBe(
      'no supabase test db run passed the whole suite (last summary: FAIL (Files=2, Tests=6), command 2)'
    );
  });

  it('fails the agent whose only passing run was for a single test file', async () => {
    const singleFile = call(
      'supabase test db supabase/tests/line_discounts.test.sql',
      'Files=1, Tests=5,  0 wallclock secs\nResult: PASS\n'
    );
    const { failed, check } = await score([
      START,
      EDIT_MIGRATION,
      RESET,
      singleFile,
    ]);
    expect(failed).toEqual([TEST_DB]);
    expect(check(TEST_DB)?.notes).toBe(
      'command 4 printed Result: PASS for 1 file(s); the seeded suite has 2'
    );
  });

  it('fails the agent that ran no commands on the pre-started stack: both seeded bugs show on the live database and the replay, while the stack, history, tests-unchanged, detours and report checks still pass', async () => {
    const { failed, check, scored, judge } = await score([], {
      files: SEEDED_FILES,
    });
    expect(scored.passed).toBe(false);
    expect(failed).toEqual([TEST_DB, LIVE, REPLAY]);
    expect(check(STACK)?.passed).toBe(true);
    expect(check(DETOURS)).toMatchObject({
      passed: true,
      notes: 'no commands executed',
    });
    expect(detourCall(judge)).toBeUndefined();
    expect(check(REPORT)?.passed).toBe(true);
    expect(check(TEST_DB)?.notes).toBe('supabase test db was never run');
    expect(check(HISTORY)?.passed).toBe(true);
    expect(check(UNCHANGED)?.passed).toBe(true);
    const live = check(LIVE)?.notes ?? '';
    expect(live).toContain(`${TOTALS_TEST}: stopped after 1 of 4 tests`);
    expect(live).toContain(
      '<stdin>:12: null value in column "discount_percent"'
    );
    expect(live).toContain(
      'not ok 2 - a 10% discount takes 10% off the line (have 300, want 2700)'
    );
    expect(live).toContain('(have 1000, want 4000)');
    expect(live).toContain('(have 2100, want 0)');
  });

  it('fails the agent that stopped the stack at the end, with the stack notes on every probed check', async () => {
    const { failed, check, commands } = await score(
      [...IN_PLACE_RUN, call('supabase stop')],
      { stack: 'down' }
    );
    expect(failed).toEqual([STACK, LIVE, REPLAY, HISTORY]);
    const notes = check(STACK)?.notes ?? '';
    expect(notes).toContain('no stack running');
    for (const name of [LIVE, REPLAY, HISTORY]) {
      expect(check(name)?.notes).toBe(notes);
    }
    expect(commands.filter((command) => /\bpsql\b/.test(command))).toEqual([]);
  });

  it('still scores the supabase test db and unchanged-tests checks when no stack resolves', async () => {
    const { check } = await score(IN_PLACE_RUN, { stack: 'down' });
    expect(check(TEST_DB)).toMatchObject({ passed: true });
    expect(check(UNCHANGED)).toMatchObject({ passed: true });
  });
});

describe('stack and history failures', () => {
  it('fails only the stack check when the database answers the probes but not select 1', async () => {
    const { failed } = await score(IN_PLACE_RUN, { ready: false });
    expect(failed).toEqual([STACK]);
  });

  it('fails only the history check, with the reason, when the migration history cannot be read', async () => {
    const { failed, check } = await score(IN_PLACE_RUN, {
      history: 'unreadable',
    });
    expect(failed).toEqual([HISTORY]);
    expect(check(HISTORY)?.notes).toContain(
      'could not read the migration history'
    );
    expect(check(HISTORY)?.notes).toContain('does not exist');
  });

  it('fails only the history check when the history holds a migration with no file', async () => {
    const { failed, check } = await score(IN_PLACE_RUN, {
      extraHistory: [{ version: '20260215000000', statements: ['select 1'] }],
    });
    expect(failed).toEqual([HISTORY]);
    expect(check(HISTORY)?.notes).toBe(
      '20260215000000 is recorded but has no migration file'
    );
  });

  it('fails only the history check when a new fix migration was never applied through the CLI', async () => {
    const { failed, check } = await score(FIX_MIGRATION_RUN, {
      files: WITH_FIX_MIGRATION,
      applied: SEEDED_FILES,
      live: { insertOk: true, totalOk: true },
    });
    expect(failed).toEqual([HISTORY]);
    expect(check(HISTORY)?.notes).toBe(
      `${FIX_FILE} is not in the migration history`
    );
  });
});

describe('workspace failures', () => {
  it('fails the replay, history and unchanged-tests checks with the workspace notes when the migrations cannot be listed, but still runs the live tests', async () => {
    const { failed, check, log } = await score(IN_PLACE_RUN, {
      listFails: true,
    });
    expect(failed).toEqual([REPLAY, HISTORY, UNCHANGED]);
    expect(check(LIVE)?.passed).toBe(true);
    const notes = check(HISTORY)?.notes ?? '';
    expect(notes).toContain('supabase/migrations');
    expect(check(REPLAY)?.notes).toBe(notes);
    expect(check(UNCHANGED)?.notes).toBe(notes);
    expect(log).not.toContain('create-replay');
  });

  it('fails the history and replay checks without touching a scratch database when there are no migration files', async () => {
    const { failed, check, log } = await score(IN_PLACE_RUN, {
      files: {},
      applied: FIXED_IN_PLACE,
    });
    expect(failed).toEqual([REPLAY, HISTORY]);
    expect(check(HISTORY)?.notes).toContain(
      'no migration files in supabase/migrations'
    );
    expect(check(REPLAY)?.notes).toContain('no migration files to replay');
    expect(log).not.toContain('create-replay');
  });
});

describe('the replay', () => {
  it('applies every migration file on disk, in version order, to a scratch database and then drops it', async () => {
    const { log, dbs, failed } = await score(FIX_MIGRATION_RUN, {
      files: WITH_FIX_MIGRATION,
    });
    expect(failed).toEqual([]);
    expect(log.filter((entry) => /replay|apply/.test(entry))).toEqual([
      'drop-replay',
      'create-replay',
      `apply ${CREATE_FILE},${DISCOUNTS_FILE},${FIX_FILE}`,
      'create-pgtap on replay',
      `run ${TOTALS_TEST} on replay`,
      `run ${DISCOUNTS_TEST} on replay`,
      'drop-pgtap on replay',
      'drop-replay',
    ]);
    expect(dbs.replay.exists).toBe(false);
  });

  it('replays the files on disk, so an unapplied fix still shows on the replay', async () => {
    const { check } = await score(IN_PLACE_RUN, {
      files: FIXED_IN_PLACE,
      applied: SEEDED_FILES,
    });
    expect(check(REPLAY)).toMatchObject({ passed: true });
  });

  it('drops the scratch database and fails the replay when a migration does not apply, without running the suite on it', async () => {
    const files = { ...FIXED_IN_PLACE, [FIX_FILE]: BROKEN_SQL };
    const { failed, check, log, dbs } = await score(IN_PLACE_RUN, { files });
    expect(failed).toEqual([REPLAY]);
    expect(check(REPLAY)?.notes).toContain('replaying the migrations stopped');
    expect(check(REPLAY)?.notes).toContain(FIX_FILE);
    expect(check(REPLAY)?.notes).toContain('syntax error');
    expect(log.filter((entry) => entry.startsWith('run '))).not.toContain(
      `run ${TOTALS_TEST} on replay`
    );
    expect(log.at(-1)).toBe('drop-replay');
    expect(dbs.replay.exists).toBe(false);
  });

  it('only ever drops or creates the eval_replay database, through the live url', async () => {
    const { commands } = await score(IN_PLACE_RUN);
    const databaseCommands = commands.filter((command) =>
      /(?:drop|create) database/i.test(command)
    );
    expect(databaseCommands.length).toBeGreaterThan(0);
    for (const command of databaseCommands) {
      expect(command).toContain(shellQuote(DB_URL));
      for (const [, name] of command.matchAll(
        /(?:drop|create) database (?:if exists )?(\w+)/gi
      )) {
        expect(name).toBe('eval_replay');
      }
    }
  });
});

describe('the live run', () => {
  it('runs the pristine seeded tests against the stack database, never the workspace copies', async () => {
    const tampered = {
      ...SEEDED_TEST_SQL,
      [DISCOUNTS_TEST]: `${SEEDED_TEST_SQL[DISCOUNTS_TEST]}\nselect 1;\n`,
    };
    const { scripts, log } = await score(IN_PLACE_RUN, { tests: tampered });
    expect(scripts.length).toBeGreaterThanOrEqual(4);
    for (const script of scripts) {
      expect(Object.values(SEEDED_TEST_SQL)).toContain(script);
    }
    expect(log).toContain(`run ${TOTALS_TEST} on live`);
    expect(log).toContain(`run ${DISCOUNTS_TEST} on live`);
  });

  it('installs pgTAP for the run when the database lacks it and removes it afterwards', async () => {
    const { log, dbs, failed } = await score(IN_PLACE_RUN, { pgtap: false });
    expect(failed).toEqual([]);
    expect(
      log.filter((entry) => entry.endsWith('on live') && /pgtap/.test(entry))
    ).toEqual(['create-pgtap on live', 'drop-pgtap on live']);
    expect(dbs.live.pgtap).toBe(false);
  });

  it('leaves pgTAP alone when the database already had it', async () => {
    const { log, dbs, failed } = await score(IN_PLACE_RUN, { pgtap: true });
    expect(failed).toEqual([]);
    expect(log.filter((entry) => /pgtap on live/.test(entry))).toEqual([]);
    expect(dbs.live.pgtap).toBe(true);
  });
});

describe('detour judge', () => {
  it('passes without a judge call when no commands ran', async () => {
    const { check, judge } = await score([]);
    expect(check(DETOURS)).toEqual({
      name: DETOURS,
      passed: true,
      notes: 'no commands executed',
    });
    expect(detourCall(judge)).toBeUndefined();
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it('receives the executed commands, numbered', async () => {
    const { judge } = await score(IN_PLACE_RUN);
    expect(detourCall(judge)?.input).toBe(
      formatDetourJudgeInput(IN_PLACE_RUN.map((record) => record.command ?? ''))
    );
  });

  it('records the verdict notes and fails when the judge fails', async () => {
    const { check, failed } = await score(IN_PLACE_RUN, {
      judge: async ({ rubric }) =>
        rubric === REPORT_RUBRIC
          ? { passed: true }
          : { passed: false, notes: 'command 3 installed docker' },
    });
    expect(check(DETOURS)).toMatchObject({
      passed: false,
      judgeNotes: 'command 3 installed docker',
    });
    expect(failed).toEqual([DETOURS]);
  });

  it('turns judge errors into failing detour and report checks without touching the others', async () => {
    const { checks, check, failed } = await score(IN_PLACE_RUN, {
      judge: async () => {
        throw new Error('judge unavailable');
      },
    });
    expect(checks.map(({ name }) => name)).toEqual(CHECK_NAMES);
    for (const name of [DETOURS, REPORT]) {
      expect(check(name)).toEqual({
        name,
        passed: false,
        notes: 'judge unavailable',
      });
    }
    expect(failed).toEqual([DETOURS, REPORT]);
  });
});

describe('report judge', () => {
  it('receives the seeded bugs as ground truth, whatever the run did', async () => {
    const { judge } = await score([]);
    const input = reportCall(judge)?.input ?? '';
    expect(input.startsWith('Ground truth observed by the harness')).toBe(true);
    expect(input).toContain(DISCOUNTS_FILE);
    expect(input).toContain('not null with no default');
    expect(input).toContain('an insert that omits it fails');
    expect(input).toContain('(100 - discount_percent) / 100');
  });

  it('receives the notes of the live, replay, history and unchanged-tests checks', async () => {
    const { judge, check } = await score(IN_PLACE_RUN, {
      files: FIXED_IN_PLACE,
      applied: SEEDED_FILES,
    });
    const input = reportCall(judge)?.input ?? '';
    for (const name of [LIVE, REPLAY, HISTORY, UNCHANGED]) {
      const notes = check(name)?.notes ?? '';
      expect(notes).not.toBe('');
      expect(input).toContain(notes);
    }
  });

  it('receives every supabase test db run in order with its summary', async () => {
    const { judge } = await score([
      START,
      TEST_DB_FAIL,
      EDIT_MIGRATION,
      RESET,
      TEST_DB_PASS,
    ]);
    const input = reportCall(judge)?.input ?? '';
    expect(input).toMatch(
      /FAIL \(Files=2, Tests=6\)[\s\S]*PASS \(Files=2, Tests=9\)/
    );
  });

  it('receives the project directory, the stack and the installed CLI', async () => {
    const { judge } = await score(IN_PLACE_RUN);
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain('/ws');
    expect(input).toContain('- local stack: resolved: managed/native');
    expect(input).toContain('2.0.0');
  });

  it('receives the new migration files the agent wrote', async () => {
    const { judge } = await score(FIX_MIGRATION_RUN, {
      files: WITH_FIX_MIGRATION,
    });
    expect(reportCall(judge)?.input).toContain(FIX_FILE);
  });

  it('receives the transcript with tool outputs after the ground truth', async () => {
    const { judge } = await score(IN_PLACE_RUN, {
      transcript: [
        {
          type: 'message',
          role: 'assistant',
          content: 'I fixed the discount formula in the migration.',
        },
        {
          type: 'tool_call',
          name: 'shell',
          input: { command: 'supabase test db' },
          output: 'All tests successful.',
        },
      ],
    });
    const input = reportCall(judge)?.input ?? '';
    expect(
      input.indexOf('I fixed the discount formula in the migration.')
    ).toBeGreaterThan(input.indexOf('Transcript:'));
    expect(input).toContain('All tests successful.');
  });

  it('is asked even when no commands ran', async () => {
    const { judge } = await score([]);
    expect(reportCall(judge)).toBeDefined();
  });

  it('records the verdict notes and fails when the judge fails', async () => {
    const { check } = await score(IN_PLACE_RUN, {
      judge: async ({ rubric }) =>
        rubric === REPORT_RUBRIC
          ? { passed: false, notes: 'claimed the tests pass when they do not' }
          : { passed: true },
    });
    expect(check(REPORT)).toMatchObject({
      passed: false,
      judgeNotes: 'claimed the tests pass when they do not',
    });
  });
});

describe('metrics check and robustness', () => {
  it('carries the supabase test db, reset and migration up counts', async () => {
    const { check } = await score(
      [START, WRITE_FIX, MIGRATION_UP, RESET, TEST_DB_FAIL, TEST_DB_PASS],
      { files: WITH_FIX_MIGRATION }
    );
    expect(check(METRICS)?.passed).toBe(true);
    expect(JSON.parse(check(METRICS)?.notes ?? '{}')).toMatchObject({
      testDbRuns: 2,
      testDbResults: ['FAIL', 'PASS'],
      resetRuns: 1,
      migrationUpRuns: 1,
      pgProveDirect: 0,
      newMigrationFiles: 1,
      seededMigrationsModified: 0,
      seededMigrationsMissing: 0,
      testFiles: 2,
      backend: 'managed',
      runtime: 'native',
      dbPort: 54322,
      cliVersion: '2.0.0',
      channel: 'beta',
    });
  });

  it('still passes the metrics check when the stack and the workspace both failed', async () => {
    const { check } = await score(IN_PLACE_RUN, {
      stack: 'down',
      listFails: true,
    });
    expect(check(METRICS)?.passed).toBe(true);
    expect(JSON.parse(check(METRICS)?.notes ?? '{}')).toMatchObject({
      testDbRuns: 1,
      resetRuns: 1,
      backend: 'none',
      runtime: 'none',
      dbPort: null,
      newMigrationFiles: null,
      testFiles: null,
    });
  });

  it('returns a single failing check when the scorer itself throws', async () => {
    const { scored } = await score(IN_PLACE_RUN, { markerThrows: true });
    expect(scored).toEqual({
      passed: false,
      checks: [
        { name: SCORER_FAILED, passed: false, notes: 'marker unreadable' },
      ],
    });
  });

  it('never rejects when the sandbox throws on every command', async () => {
    const { scored } = await score(IN_PLACE_RUN, { execThrows: true });
    expect(scored.passed).toBe(false);
    expect([CHECK_NAMES, [SCORER_FAILED]]).toContainEqual(
      scored.checks?.map(({ name }) => name)
    );
  });
});
