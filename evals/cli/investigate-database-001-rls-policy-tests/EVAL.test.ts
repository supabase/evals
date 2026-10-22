// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-001-rls-policy-tests
import { readFileSync } from 'node:fs';
import type {
  CommandResult,
  JudgeInput,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
  ToolCallRecord,
  TranscriptPart,
} from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import scorer from './EVAL.js';
import {
  LEAKY_POLICY_NAME,
  SEEDED_MIGRATION_FILE,
  SEEDED_MIGRATION_VERSION,
} from './fixtures.js';
import { buildSnapshotSql } from './snapshot.js';

const WS = '/ws';
const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const MUTATION_MARKER = 'eval-mutation-applied';
const CONTROL_MARKER = 'eval-control-run';

const SEEDED_SQL = readFileSync(
  new URL(
    `./local/supabase/migrations/${SEEDED_MIGRATION_FILE}`,
    import.meta.url
  ),
  'utf8'
);
const SEEDED_WITHOUT_LEAK = SEEDED_SQL.replace(
  SEEDED_SQL.slice(SEEDED_SQL.indexOf(`create policy "${LEAKY_POLICY_NAME}"`)),
  ''
);

const DROP_LEAK = `drop policy "${LEAKY_POLICY_NAME}" on public.notes;\n`;
const FIX_FILE = '20260102000000_fix_notes_policy.sql';
const FIX_VERSION = '20260102000000';
const SECOND_FILE = '20260103000000_tighten_notes.sql';
const SECOND_VERSION = '20260103000000';
const SECOND_SQL =
  'alter policy "Users can view their own notes" on public.notes using ((select auth.uid()) = owner_id);\n';

const MARKER: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'beta',
  cliVersion: '2.0.0',
  docker: 'available',
  sessionStartedMs: 1_000,
};

const FIXED_ROWS = `read.anon|titles:
read.other|titles:eval-probe-other-1
read.owner|titles:eval-probe-owner-1,eval-probe-owner-2
write.otherDelete|rows:0
write.otherInsertAsOwner|denied:42501
write.otherUpdate|rows:0
write.ownerInsert|rows:1
write.ownerUpdate|rows:1
`;
const LEAKY_ROWS = FIXED_ROWS.replace(
  'read.other|titles:eval-probe-other-1',
  'read.other|titles:eval-probe-other-1,eval-probe-owner-1,eval-probe-owner-2'
).replace(
  'read.owner|titles:eval-probe-owner-1,eval-probe-owner-2',
  'read.owner|titles:eval-probe-other-1,eval-probe-owner-1,eval-probe-owner-2'
);
const withBlankLines = (rows: string) => `${'\n'.repeat(8)}${rows}`;

const PASSING_TAP = `1..3
ok 1 - owner sees their own notes
ok 2 - other user sees none of the owner's notes
ok 3 - anon sees no notes
`;
const FAILING_TAP = `1..3
ok 1 - owner sees their own notes
not ok 2 - other user sees none of the owner's notes
# Failed test 2: "other user sees none of the owner's notes"
#         have: 2
#         want: 0
ok 3 - anon sees no notes
# Looks like you failed 1 test of 3
`;
const ERRORED_TAP = `1..3
not ok 1 - owner sees their own notes
# Failed test 1: "owner sees their own notes"
#         have: 2
#         want: 1
`;
const NO_PLAN_PASSING_TAP = `ok 1 - owner sees their own notes
ok 2 - other user sees none of the owner's notes
ok 3 - anon sees no notes
1..3
`;
const NO_PLAN_FAILING_TAP = `ok 1 - owner sees their own notes
not ok 2 - other user sees none of the owner's notes
# Failed test 2: "other user sees none of the owner's notes"
ok 3 - anon sees no notes
1..3
`;

const TEST_DB_PASS = `/tmp/tests/notes_rls_test.sql .. ok
All tests successful.
Files=1, Tests=3,  0 wallclock secs ( 0.01 usr +  0.01 sys =  0.02 CPU)
Result: PASS
`;
const TEST_DB_FAIL = `/tmp/tests/notes_rls_test.sql .. 
# Failed test 2: "other user sees none of the owner's notes"
#         have: 2
#         want: 0
Failed 1/3 subtests 

Test Summary Report
-------------------
/tmp/tests/notes_rls_test.sql (Wstat: 256 (exited 1) Tests: 3 Failed: 1)
  Failed test:  2
Files=1, Tests=3,  0 wallclock secs ( 0.02 usr +  0.02 sys =  0.04 CPU)
Result: FAIL
error running pg_prove: exit 1
`;
const TEST_DB_NOTESTS = `Files=0, Tests=0,  0 wallclock secs ( 0.00 usr +  0.00 sys =  0.00 CPU)
Result: NOTESTS
no pgTAP tests found in supabase/tests
`;
const DOCKER_ERROR =
  'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\nerror running container: exit 1';

function result(
  stdout: string,
  ok = true,
  stderr = '',
  exitCode = ok ? 0 : 1
): CommandResult {
  return { ok, exitCode, stdout, stderr };
}

function call(command: string, output = '', cwd?: string): ToolCallRecord {
  return {
    tool: { kind: 'other', toolName: 'shell' },
    body: { command },
    command,
    ...(cwd === undefined ? {} : { cwd }),
    result: output,
    ts: 0,
  };
}

const scriptOf = (command: string) => {
  const payload = /printf %s '([A-Za-z0-9+/]+={0,2})'/.exec(command)?.[1];
  return payload === undefined
    ? command
    : Buffer.from(payload, 'base64').toString('utf8');
};

const hex = (text: string) => Buffer.from(text, 'utf8').toString('hex');
const SNAPSHOT_ROWS = `policy|${hex(`create policy "Users can view their own notes" on public.notes as PERMISSIVE for SELECT to authenticated using (true)`)}
rls|true|false
`;

type Run = { stdout: string; exitCode?: number; stderr?: string };
type Behaviour = { clean: Run; mutated?: Run; rerun?: Run };

const CATCHING: Behaviour = {
  clean: { stdout: PASSING_TAP },
  mutated: { stdout: `${MUTATION_MARKER}\n${FAILING_TAP}` },
  rerun: { stdout: PASSING_TAP },
};
const BLIND: Behaviour = {
  clean: { stdout: PASSING_TAP },
  mutated: { stdout: `${MUTATION_MARKER}\n${PASSING_TAP}` },
  rerun: { stdout: PASSING_TAP },
};
const FAILING: Behaviour = { clean: { stdout: FAILING_TAP } };
const ERRORING: Behaviour = {
  clean: {
    stdout: ERRORED_TAP,
    exitCode: 3,
    stderr: 'psql:notes_rls_test.sql:12: ERROR:  more than one row returned',
  },
};

type World = {
  stack?: 'up' | 'down' | 'refusing';
  home?: string;
  files?: Record<string, string>;
  history?: string[];
  recordedStatements?: Record<string, string>;
  access?: string | 'fails';
  tests?: Record<string, Behaviour> | null;
  extraTestFiles?: string[];
  pgtap?: boolean;
  judge?: (args: JudgeInput) => Promise<{ passed: boolean; notes?: string }>;
  transcript?: TranscriptPart[];
  marker?: LocalStackEnvironmentMarker | 'throws';
  execThrows?: boolean;
};

const HAPPY = {
  stack: 'up',
  files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL, [FIX_FILE]: DROP_LEAK },
  history: [SEEDED_MIGRATION_VERSION, FIX_VERSION],
  access: withBlankLines(FIXED_ROWS),
  tests: { 'notes_rls_test.sql': CATCHING },
} satisfies World;

function fakeCtx(toolCalls: ToolCallRecord[], world: World = {}) {
  const stack = world.stack ?? HAPPY.stack;
  const files: Record<string, string> = world.files ?? HAPPY.files;
  const history = world.history ?? HAPPY.history;
  const access = world.access ?? HAPPY.access;
  const tests: Record<string, Behaviour> | null =
    world.tests === undefined ? HAPPY.tests : world.tests;
  const judge = vi.fn(
    world.judge ?? (async () => ({ passed: true, notes: 'ok' }))
  );
  const state = { pgtap: world.pgtap ?? false };
  const dirty = new Set<string>();
  const log: string[] = [];

  const homeMatches = (command: string) =>
    world.home === undefined
      ? !/(?:SUPABASE_HOME|HOME)=/.test(command)
      : command.includes(`SUPABASE_HOME='${world.home}'`);

  const psql = (command: string): CommandResult => {
    if (!command.includes(DB_URL) || stack !== 'up') {
      return result('', false, 'psql: error: connection refused', 2);
    }
    if (command.includes('pg_extension')) {
      const present = state.pgtap;
      if (/count\s*\(/i.test(command)) return result(present ? '1\n' : '0\n');
      if (/\bexists\s*\(/i.test(command))
        return result(present ? 't\n' : 'f\n');
      if (/select\s+extname/i.test(command)) {
        return result(present ? 'pgtap\n' : '');
      }
      return result(present ? '1\n' : '');
    }
    if (/create\s+extension/i.test(command)) {
      state.pgtap = true;
      log.push('create-extension');
      return result('');
    }
    if (/drop\s+extension/i.test(command)) {
      state.pgtap = false;
      log.push('drop-extension');
      return result('');
    }
    if (command.includes('schema_migrations')) {
      const asked = [...command.matchAll(/'(\d+)'/g)].map((m) => m[1]);
      const rows = history
        .filter((version) => asked.includes(version))
        .map((version) => {
          const name = Object.keys(files).find((file) =>
            file.startsWith(`${version}_`)
          );
          const statements =
            world.recordedStatements?.[version] ??
            (name === undefined ? '' : files[name]);
          return `${version}|${hex(statements)}`;
        });
      return result(rows.length > 0 ? `${rows.join('\n')}\n` : '');
    }
    if (/-tAc\s+'select 1'\s*$/.test(command)) return result('1\n');

    const fileArgs = [
      ...command.matchAll(/(?:^|\s)-f\s+('[^']*'|"[^"]*"|\S+)/g),
    ].map(([, arg]) => arg.replace(/^['"]|['"]$/g, ''));
    const target = fileArgs.find((arg) => arg !== '-');
    if (target === undefined) {
      const script = fileArgs.includes('-') ? scriptOf(command) : '';
      if (script.includes('eval_probe')) {
        return access === 'fails'
          ? result(
              '',
              false,
              'ERROR:  relation "public.notes" does not exist',
              3
            )
          : result(access);
      }
      if (script.trim() === buildSnapshotSql().trim()) {
        return result(SNAPSHOT_ROWS);
      }
      return result('', false, `unexpected command: ${command}`);
    }
    const key = target.replace(/^.*supabase\/tests\//, '');
    const behaviour = tests?.[key];
    if (behaviour === undefined) {
      return result('', false, `unexpected command: ${command}`);
    }
    const run = (output: Run) =>
      result(
        output.stdout,
        (output.exitCode ?? 0) === 0,
        output.stderr ?? '',
        output.exitCode ?? 0
      );
    if (fileArgs.includes('-') && scriptOf(command).includes(MUTATION_MARKER)) {
      log.push(`mutate ${key}`);
      dirty.add(key);
      return run(behaviour.mutated ?? behaviour.clean);
    }
    if (dirty.delete(key)) {
      expect(fileArgs).toContain('-');
      expect(scriptOf(command)).toContain(CONTROL_MARKER);
      log.push(`rerun ${key}`);
      return run(behaviour.rerun ?? behaviour.clean);
    }
    log.push(`clean ${key}`);
    return run(behaviour.clean);
  };

  const exec = async (command: string): Promise<CommandResult> => {
    if (world.execThrows) throw new Error('sandbox gone');
    if (command.endsWith('supabase --version')) return result('2.0.0\n');
    if (/supabase stack status/.test(command)) {
      if (stack === 'down' || !homeMatches(command)) {
        return result('', false, 'no stack running');
      }
      return command.includes('--env')
        ? result(JSON.stringify({ DB_URL }))
        : result(JSON.stringify({ runtime: 'native' }));
    }
    if (/supabase (stack list|status)/.test(command)) {
      return result('', false, 'no stack running');
    }
    if (/\bpsql\b/.test(command)) return psql(command);

    const cat = command.match(/^cat\s+'?supabase\/migrations\/([^'\s]+)'?\s*$/);
    if (cat) {
      return cat[1] in files
        ? result(files[cat[1]])
        : result('', false, `cat: ${cat[1]}: No such file or directory`);
    }
    if (command.includes('supabase/migrations')) {
      const names = Object.keys(files).sort();
      return command.includes('find ')
        ? result(names.map((name) => `supabase/migrations/${name}`).join('\n'))
        : result(names.join('\n'));
    }
    if (command.includes('supabase/tests')) {
      if (tests === null) {
        return result(
          '',
          false,
          "find: 'supabase/tests': No such file or directory",
          1
        );
      }
      const names = [...Object.keys(tests), ...(world.extraTestFiles ?? [])];
      return result(
        names
          .reverse()
          .map((name) => `supabase/tests/${name}`)
          .join('\n')
      );
    }
    return result('', false, `unexpected command: ${command}`);
  };

  const ctx = {
    workspace: WS,
    exec,
    folderExists: async (path: string) => path === 'supabase/migrations',
    toolCalls,
    transcript: world.transcript ?? [],
    environmentMarker: async () => {
      if (world.marker === 'throws') throw new Error('marker unreadable');
      return world.marker ?? MARKER;
    },
    judge,
  } as unknown as LocalStackEvalContext;
  return { ctx, judge, state, log };
}

const CHECK_NAMES = [
  'local stack is running for this project',
  'each user can see only their own notes',
  "only a note's owner can change it",
  'the notes policy fix is in an applied migration',
  "the project's pgTAP tests pass against the local database",
  'the tests fail when the seeded notes policies are put back',
  'the tests were run with supabase test db',
  'no container-runtime detours',
  'metrics',
  'final report is truthful about the tests and the fix',
];

const [
  STACK,
  READ,
  WRITE,
  MIGRATION,
  TESTS_PASS,
  TESTS_CATCH,
  TEST_DB,
  DETOURS,
  METRICS,
  REPORT,
] = CHECK_NAMES;

const WRITE_TEST = call(
  `cat > supabase/tests/notes_rls_test.sql <<'EOF'\nbegin;\nselect plan(3);\nselect * from finish();\nrollback;\nEOF`
);
const WRITE_FIX = call(
  `cat > supabase/migrations/${FIX_FILE} <<'EOF'\n${DROP_LEAK}EOF`
);
const testDb = (output = TEST_DB_PASS) => call('supabase test db', output);

const SETUP = [
  call('supabase start'),
  WRITE_TEST,
  WRITE_FIX,
  call('supabase migration up'),
  testDb(),
];

const failedNames = async (ctx: LocalStackEvalContext) =>
  ((await scorer(ctx)).checks ?? [])
    .filter(({ passed }) => !passed)
    .map(({ name }) => name);

const checkOf = async (ctx: LocalStackEvalContext, name: string) =>
  (await scorer(ctx)).checks?.find((check) => check.name === name);

const isReportCall = ({ input }: JudgeInput) =>
  input.startsWith('Ground truth observed by the harness after the run:');

const judgeCall = (
  judge: ReturnType<typeof fakeCtx>['judge'],
  which: 'report' | 'detour'
) =>
  judge.mock.calls
    .map(([args]) => args)
    .find((args) => isReportCall(args) === (which === 'report'));

const groundTruthLines = (input: string) =>
  input.split('\nTranscript:')[0].split('\n');

const COMMENTED_OUT = `-- ${DROP_LEAK}`;

describe('notes test scorer', () => {
  it('passes a fixed, migrated, tested and CLI-run project, in the declared check order', async () => {
    const { ctx } = fakeCtx(SETUP);
    const scored = await scorer(ctx);
    expect(scored.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(scored.checks?.filter(({ passed }) => !passed)).toEqual([]);
    expect(scored.passed).toBe(true);
  });

  it('fails when any check fails', async () => {
    const { ctx } = fakeCtx(SETUP, { access: withBlankLines(LEAKY_ROWS) });
    expect((await scorer(ctx)).passed).toBe(false);
  });

  it('returns a single failing check when the scorer itself throws', async () => {
    const { ctx } = fakeCtx(SETUP, { marker: 'throws' });
    expect(await scorer(ctx)).toEqual({
      passed: false,
      checks: [
        {
          name: 'scorer evaluated the notes tests',
          passed: false,
          notes: 'marker unreadable',
        },
      ],
    });
  });

  it('still reports all ten checks when every command in the sandbox throws', async () => {
    const { ctx } = fakeCtx(SETUP, { execThrows: true });
    const scored = await scorer(ctx);
    expect(scored.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(await failedNames(ctx)).toEqual([
      STACK,
      READ,
      WRITE,
      MIGRATION,
      TESTS_PASS,
      TESTS_CATCH,
    ]);
  });

  it('drops pgtap again when the agent had not installed it', async () => {
    const { ctx, state, log } = fakeCtx(SETUP, { pgtap: false });
    await scorer(ctx);
    expect(state.pgtap).toBe(false);
    expect(log.filter((line) => line.endsWith('-extension'))).toEqual([
      'create-extension',
      'drop-extension',
    ]);
  });

  it('leaves pgtap installed, and never creates it, when the agent had installed it', async () => {
    const { ctx, state, log } = fakeCtx(SETUP, { pgtap: true });
    await scorer(ctx);
    expect(state.pgtap).toBe(true);
    expect(log).not.toContain('create-extension');
    expect(log).not.toContain('drop-extension');
  });

  it('runs a passing file clean, under the seeded policies, then clean again', async () => {
    const { ctx, log } = fakeCtx(SETUP);
    await scorer(ctx);
    expect(log.filter((line) => line.endsWith(' notes_rls_test.sql'))).toEqual([
      'clean notes_rls_test.sql',
      'mutate notes_rls_test.sql',
      'rerun notes_rls_test.sql',
    ]);
  });
});

describe('known-bad runs', () => {
  it.each([
    [
      'never started the stack',
      [],
      {
        stack: 'down',
        files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL },
        history: [SEEDED_MIGRATION_VERSION],
        tests: null,
      },
      [STACK, READ, WRITE, MIGRATION, TESTS_PASS, TESTS_CATCH, TEST_DB],
    ],
    [
      'started the stack but its database refuses connections',
      SETUP,
      { stack: 'refusing' },
      [STACK, READ, WRITE, MIGRATION, TESTS_PASS, TESTS_CATCH],
    ],
    [
      'wrote tests that turn up the leak and never fixed it',
      [call('supabase start'), WRITE_TEST, testDb(TEST_DB_FAIL)],
      {
        access: withBlankLines(LEAKY_ROWS),
        files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL },
        history: [SEEDED_MIGRATION_VERSION],
        tests: { 'notes_rls_test.sql': FAILING },
      },
      [READ, MIGRATION, TESTS_PASS, TESTS_CATCH],
    ],
    [
      'wrote the fix migration but never applied it',
      SETUP.slice(0, 3),
      {
        access: withBlankLines(LEAKY_ROWS),
        history: [SEEDED_MIGRATION_VERSION],
        tests: { 'notes_rls_test.sql': FAILING },
      },
      [READ, MIGRATION, TESTS_PASS, TESTS_CATCH, TEST_DB],
    ],
    [
      'fixed the policy with psql and never wrote a migration',
      [
        call('supabase start'),
        WRITE_TEST,
        call(
          `psql "$DATABASE_URL" -c 'drop policy "${LEAKY_POLICY_NAME}" on public.notes'`
        ),
        testDb(),
      ],
      {
        files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL },
        history: [SEEDED_MIGRATION_VERSION],
      },
      [MIGRATION],
    ],
    [
      'wrote the fix migration but applied it with psql -f, leaving no history row',
      [
        call('supabase start'),
        WRITE_TEST,
        WRITE_FIX,
        call(`psql "$DATABASE_URL" -f supabase/migrations/${FIX_FILE}`),
        testDb(),
      ],
      { history: [SEEDED_MIGRATION_VERSION] },
      [MIGRATION],
    ],
    [
      'edited the seeded migration without resetting the database',
      [call('supabase start'), WRITE_TEST, testDb()],
      {
        files: { [SEEDED_MIGRATION_FILE]: SEEDED_WITHOUT_LEAK },
        history: [SEEDED_MIGRATION_VERSION],
        recordedStatements: { [SEEDED_MIGRATION_VERSION]: SEEDED_SQL },
      },
      [MIGRATION],
    ],
    [
      'recorded the fix migration with migration repair, so its history row is empty',
      [
        call('supabase start'),
        WRITE_TEST,
        WRITE_FIX,
        call(
          `supabase migration repair --status applied ${FIX_VERSION} --local`
        ),
        testDb(),
      ],
      { recordedStatements: { [FIX_VERSION]: '' } },
      [MIGRATION],
    ],
    [
      'dated the fix migration before the seeded one',
      SETUP,
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          '20251231000000_fix_notes_policy.sql': DROP_LEAK,
        },
        history: [SEEDED_MIGRATION_VERSION, '20251231000000'],
      },
      [MIGRATION],
    ],
    [
      'commented the drop policy statement out',
      SETUP,
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [FIX_FILE]: COMMENTED_OUT,
        },
      },
      [MIGRATION],
    ],
    [
      'dropped the policy on the look-alike table notes_archive',
      SETUP,
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [FIX_FILE]: DROP_LEAK.replace('public.notes', 'public.notes_archive'),
        },
      },
      [MIGRATION],
    ],
    [
      'wrote two policy migrations and applied only the first',
      SETUP,
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [FIX_FILE]: DROP_LEAK,
          [SECOND_FILE]: SECOND_SQL,
        },
      },
      [MIGRATION],
    ],
    [
      'closed the leak by hiding every note, even from its owner',
      SETUP,
      {
        access: withBlankLines(
          FIXED_ROWS.replace(
            'read.owner|titles:eval-probe-owner-1,eval-probe-owner-2',
            'read.owner|titles:'
          )
        ),
      },
      [READ],
    ],
    [
      'left the update policy open to every signed-in user',
      SETUP,
      {
        access: withBlankLines(
          FIXED_ROWS.replace(
            'write.otherUpdate|rows:0',
            'write.otherUpdate|rows:1'
          )
        ),
      },
      [WRITE],
    ],
    [
      'dropped the insert policy, so an owner can no longer add notes',
      SETUP,
      {
        access: withBlankLines(
          FIXED_ROWS.replace(
            'write.ownerInsert|rows:1',
            'write.ownerInsert|denied:42501'
          )
        ),
      },
      [WRITE],
    ],
    [
      'broke the database so the access probe cannot run',
      SETUP,
      { access: 'fails' },
      [READ, WRITE],
    ],
    [
      'wrote no tests',
      [call('supabase start'), WRITE_FIX, call('supabase migration up')],
      { tests: null },
      [TESTS_PASS, TESTS_CATCH, TEST_DB],
    ],
    [
      'left the tests folder empty',
      [call('supabase start'), WRITE_FIX, call('supabase migration up')],
      { tests: {} },
      [TESTS_PASS, TESTS_CATCH, TEST_DB],
    ],
    [
      'wrote tests that pass whatever the policies are',
      SETUP,
      { tests: { 'notes_rls_test.sql': BLIND } },
      [TESTS_CATCH],
    ],
    [
      'wrote a test file that dies on an error',
      [...SETUP.slice(0, 4), testDb(TEST_DB_FAIL)],
      { tests: { 'notes_rls_test.sql': ERRORING } },
      [TESTS_PASS, TESTS_CATCH],
    ],
    [
      'left a helper file with no plan beside a catching test file',
      SETUP,
      {
        tests: {
          'notes_rls_test.sql': CATCHING,
          'helpers.sql': { clean: { stdout: '' } },
        },
      },
      [TESTS_PASS],
    ],
    [
      'ran the tests with psql only',
      [
        ...SETUP.slice(0, 4),
        call(
          'psql "$DATABASE_URL" -f supabase/tests/notes_rls_test.sql',
          PASSING_TAP
        ),
      ],
      {},
      [TEST_DB],
    ],
    [
      'ran the tests with pg_prove by hand only',
      [
        ...SETUP.slice(0, 4),
        call(
          'pg_prove -d "$DATABASE_URL" supabase/tests/notes_rls_test.sql',
          'Result: PASS\n'
        ),
      ],
      {},
      [TEST_DB],
    ],
    [
      'ran supabase test db into a Docker error',
      [...SETUP.slice(0, 4), testDb(DOCKER_ERROR)],
      {},
      [TEST_DB],
    ],
    [
      'ran supabase test db with no tests to find',
      [...SETUP.slice(0, 4), testDb(TEST_DB_NOTESTS)],
      {},
      [TEST_DB],
    ],
    [
      'only mentioned supabase test db in a heredoc',
      [
        ...SETUP.slice(0, 4),
        call(`cat > notes.md <<'EOF'\nrun supabase test db\nEOF`),
      ],
      {},
      [TEST_DB],
    ],
  ] satisfies Array<[string, ToolCallRecord[], World, string[]]>)(
    'fails only the checks the run got wrong when it %s',
    async (_label, toolCalls, world, expected) => {
      const { ctx } = fakeCtx(toolCalls, world);
      expect(await failedNames(ctx)).toEqual(expected);
    }
  );
});

describe('valid alternatives', () => {
  it.each([
    [
      'drops the policy with if exists',
      SETUP,
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [FIX_FILE]: `drop policy if exists "${LEAKY_POLICY_NAME}" on public.notes;\n`,
        },
      },
    ],
    [
      'writes db diff output with quoted identifiers',
      SETUP,
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [FIX_FILE]: `drop policy "${LEAKY_POLICY_NAME}" on "public"."notes";\n`,
        },
      },
    ],
    [
      'replaces every policy with a single owner policy for all commands',
      SETUP,
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [FIX_FILE]: [
            'Users can view their own notes',
            'Users can create their own notes',
            'Users can update their own notes',
            'Users can delete their own notes',
            LEAKY_POLICY_NAME,
          ]
            .map((name) => `drop policy "${name}" on public.notes;`)
            .concat(
              'create policy "Owners manage their notes" on public.notes for all to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);'
            )
            .join('\n'),
        },
      },
    ],
    [
      'adds a restrictive owner policy on top of the leaky one',
      SETUP,
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [FIX_FILE]:
            'create policy "Owners only" on public.notes as restrictive for select to authenticated using ((select auth.uid()) = owner_id);\n',
        },
      },
    ],
    [
      'writes two policy migrations and applies both',
      SETUP,
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [FIX_FILE]: DROP_LEAK,
          [SECOND_FILE]: SECOND_SQL,
        },
        history: [SEEDED_MIGRATION_VERSION, FIX_VERSION, SECOND_VERSION],
      },
    ],
    [
      'edits the seeded migration and resets the database',
      [call('supabase start'), WRITE_TEST, call('supabase db reset'), testDb()],
      {
        files: { [SEEDED_MIGRATION_FILE]: SEEDED_WITHOUT_LEAK },
        history: [SEEDED_MIGRATION_VERSION],
      },
    ],
    [
      'writes tests in several files, a subdirectory and a .pg file',
      SETUP,
      {
        tests: {
          'a_test.sql': CATCHING,
          'nested/b_test.pg': CATCHING,
          'nested/deep/c_test.sql': CATCHING,
        },
      },
    ],
    [
      'writes no_plan tests whose plan comes last',
      SETUP,
      {
        tests: {
          'notes_rls_test.sql': {
            clean: { stdout: NO_PLAN_PASSING_TAP },
            mutated: { stdout: `${MUTATION_MARKER}\n${NO_PLAN_FAILING_TAP}` },
            rerun: { stdout: NO_PLAN_PASSING_TAP },
          },
        },
      },
    ],
    [
      'writes one catching file beside one that passes under the seeded policies too',
      SETUP,
      {
        tests: {
          'notes_rls_test.sql': CATCHING,
          'anon_test.sql': BLIND,
        },
      },
    ],
    [
      'ignores non-test files in the tests folder',
      SETUP,
      { extraTestFiles: ['README.md', 'helpers.sh'] },
    ],
    [
      'sees supabase test db fail, fixes the leak and runs it again',
      [
        call('supabase start'),
        WRITE_TEST,
        testDb(TEST_DB_FAIL),
        WRITE_FIX,
        call('supabase migration up'),
        testDb(),
      ],
      {},
    ],
    [
      'runs supabase test db through npx',
      [
        ...SETUP.slice(0, 4),
        call('npx --yes supabase@2.1.0 test db', TEST_DB_PASS),
      ],
      {},
    ],
    [
      'runs supabase test db for one file against the local database',
      [
        ...SETUP.slice(0, 4),
        call(
          'supabase test db --local supabase/tests/notes_rls_test.sql',
          TEST_DB_PASS
        ),
      ],
      {},
    ],
    [
      'also runs the tests with psql and pg_prove by hand',
      [
        ...SETUP,
        call(
          'psql "$DATABASE_URL" -f supabase/tests/notes_rls_test.sql',
          PASSING_TAP
        ),
        call(
          'pg_prove -d "$DATABASE_URL" supabase/tests/notes_rls_test.sql',
          'Result: PASS\n'
        ),
        call('psql "$DATABASE_URL" -c "select * from pg_policies"'),
      ],
      {},
    ],
    [
      'had installed pgtap itself',
      [call('supabase start'), WRITE_TEST, WRITE_FIX, testDb()],
      { pgtap: true },
    ],
  ] satisfies Array<[string, ToolCallRecord[], World]>)(
    'passes when the agent %s',
    async (_label, toolCalls, world) => {
      const { ctx } = fakeCtx(toolCalls, world);
      expect(await failedNames(ctx)).toEqual([]);
    }
  );

  it('finds a stack the agent started under a SUPABASE_HOME it set itself', async () => {
    const home = '/home/agent/.supabase-local';
    const { ctx } = fakeCtx(
      [
        call(`SUPABASE_HOME=${home} supabase start`, '', WS),
        WRITE_TEST,
        WRITE_FIX,
        testDb(),
      ],
      { home }
    );
    expect(await failedNames(ctx)).toEqual([]);
  });

  it('finds a stack under the SUPABASE_HOME the sandbox was started with', async () => {
    const home = '/sandbox/.supabase-home';
    const { ctx } = fakeCtx(
      [call('supabase start', '', WS), WRITE_TEST, WRITE_FIX, testDb()],
      { home, marker: { ...MARKER, env: { SUPABASE_HOME: home } } }
    );
    expect(await failedNames(ctx)).toEqual([]);
  });

  it('does not find a relocated stack when nothing says where it lives', async () => {
    const { ctx } = fakeCtx(SETUP, { home: '/home/agent/.supabase-local' });
    expect(await failedNames(ctx)).toEqual([
      STACK,
      READ,
      WRITE,
      MIGRATION,
      TESTS_PASS,
      TESTS_CATCH,
    ]);
  });
});

describe('check notes', () => {
  it('names the leak in the read check when another user can see the owner notes', async () => {
    const { ctx } = fakeCtx(SETUP, { access: withBlankLines(LEAKY_ROWS) });
    const check = await checkOf(ctx, READ);
    expect(check?.passed).toBe(false);
    expect(check?.notes).toMatch(/other user.*owner/i);
  });

  it('names the file that did not catch the seeded policies', async () => {
    const { ctx } = fakeCtx(SETUP, {
      tests: { 'notes_rls_test.sql': BLIND },
    });
    const check = await checkOf(ctx, TESTS_CATCH);
    expect(check?.passed).toBe(false);
    expect(check?.notes).toContain('supabase/tests/notes_rls_test.sql');
  });

  it('names the failing file in the pass check', async () => {
    const { ctx } = fakeCtx(SETUP, {
      tests: { 'notes_rls_test.sql': ERRORING },
    });
    const check = await checkOf(ctx, TESTS_PASS);
    expect(check?.passed).toBe(false);
    expect(check?.notes).toContain('supabase/tests/notes_rls_test.sql');
  });
});

describe('metrics check', () => {
  const metrics = async (ctx: LocalStackEvalContext) =>
    JSON.parse((await checkOf(ctx, METRICS))?.notes ?? '{}');

  it('reports the facts of a finished run', async () => {
    const { ctx } = fakeCtx(SETUP);
    expect(await metrics(ctx)).toMatchObject({
      cliVersion: '2.0.0',
      channel: 'beta',
      backend: 'managed',
      runtime: 'native',
      dbPort: 54322,
      testFiles: 1,
      testsPlanned: 3,
      testsPassedClean: 3,
      catchingFiles: 1,
      testDbRuns: 1,
      testDbResults: ['PASS'],
      directPolicyDdl: 0,
      pgProveDirect: 0,
      seededMigrationModified: false,
      newMigrationFiles: 1,
      cliDetours: 0,
    });
  });

  it('counts the policy ddl the agent ran straight against the database', async () => {
    const { ctx } = fakeCtx([
      ...SETUP,
      call(
        `psql "$DATABASE_URL" -c 'drop policy "${LEAKY_POLICY_NAME}" on public.notes'`
      ),
    ]);
    expect((await metrics(ctx)).directPolicyDdl).toBe(1);
  });

  it('counts pg_prove runs by hand and lists the test db results in order', async () => {
    const { ctx } = fakeCtx([
      call('supabase start'),
      WRITE_TEST,
      testDb(TEST_DB_FAIL),
      call(
        'pg_prove -d "$DATABASE_URL" supabase/tests/notes_rls_test.sql',
        'Result: PASS\n'
      ),
      WRITE_FIX,
      testDb(),
    ]);
    expect(await metrics(ctx)).toMatchObject({
      pgProveDirect: 1,
      testDbRuns: 2,
      testDbResults: ['FAIL', 'PASS'],
    });
  });

  it('reports the edited seeded migration', async () => {
    const { ctx } = fakeCtx(SETUP, {
      files: { [SEEDED_MIGRATION_FILE]: SEEDED_WITHOUT_LEAK },
      history: [SEEDED_MIGRATION_VERSION],
    });
    expect(await metrics(ctx)).toMatchObject({
      seededMigrationModified: true,
      newMigrationFiles: 0,
    });
  });

  it('reports null for what it could not read when the stack is down', async () => {
    const { ctx } = fakeCtx(SETUP, { stack: 'down' });
    expect(await metrics(ctx)).toMatchObject({
      backend: 'none',
      runtime: 'none',
      dbPort: null,
      testFiles: null,
      testsPlanned: null,
      testsPassedClean: null,
      catchingFiles: null,
    });
  });

  it('always passes', async () => {
    const { ctx } = fakeCtx([], { stack: 'down', execThrows: true });
    expect((await checkOf(ctx, METRICS))?.passed).toBe(true);
  });
});

describe('detour judge', () => {
  it('receives every command numbered and in full, with what counts as normal work', async () => {
    const longCommand = `cat > supabase/tests/notes_rls_test.sql <<'EOF'\n${'select ok(true);\n'.repeat(150)}EOF`;
    expect(longCommand.length).toBeGreaterThan(2000);
    const calls = [call('supabase start'), call(longCommand), testDb()];
    const { ctx, judge } = fakeCtx(calls);
    await scorer(ctx);
    const sent = judgeCall(judge, 'detour');
    expect(sent?.input).toBe(
      calls.map((record, i) => `${i + 1}. ${record.command}`).join('\n')
    );
    expect(sent?.rubric).toContain('container runtime');
    expect(sent?.rubric).toContain('psql');
    expect(sent?.rubric).toContain('pg_prove');
  });

  it('is not called when the agent ran no commands', async () => {
    const { ctx, judge } = fakeCtx([]);
    expect(await checkOf(ctx, DETOURS)).toMatchObject({
      name: DETOURS,
      passed: true,
    });
    expect(judgeCall(judge, 'detour')).toBeUndefined();
  });

  it('records the verdict notes and fails when the judge fails', async () => {
    const { ctx } = fakeCtx(SETUP, {
      judge: async (args) =>
        isReportCall(args)
          ? { passed: true }
          : { passed: false, notes: 'command 1 installed docker' },
    });
    expect(await checkOf(ctx, DETOURS)).toMatchObject({
      passed: false,
      judgeNotes: 'command 1 installed docker',
    });
    expect(await failedNames(ctx)).toEqual([DETOURS]);
  });

  it('fails only this check when the judge throws', async () => {
    const { ctx } = fakeCtx(SETUP, {
      judge: async (args) => {
        if (!isReportCall(args)) throw new Error('judge unavailable');
        return { passed: true };
      },
    });
    expect(await checkOf(ctx, DETOURS)).toEqual({
      name: DETOURS,
      passed: false,
      notes: 'judge unavailable',
    });
    expect(await failedNames(ctx)).toEqual([DETOURS]);
  });
});

describe('report judge', () => {
  it('receives the harness ground truth for a finished run', async () => {
    const { ctx, judge } = fakeCtx(SETUP);
    await scorer(ctx);
    const input = judgeCall(judge, 'report')?.input ?? '';
    expect(input).toContain('- project directory: /ws');
    expect(input).toContain('- local stack: resolved: managed/native');
    expect(input).toContain(
      '- reads of the probe notes: owner sees eval-probe-owner-1, eval-probe-owner-2; other user sees eval-probe-other-1; anon sees nothing'
    );
    expect(input).toContain(
      `- migrations touching the notes policies: ${FIX_FILE} (version ${FIX_VERSION})`
    );
    expect(input).toContain(
      `- recorded in the local migration history: yes (${FIX_FILE} (version ${FIX_VERSION}))`
    );
    expect(input).toContain(
      '- test files under supabase/tests: supabase/tests/notes_rls_test.sql'
    );
    expect(input).toContain(
      '- test file supabase/tests/notes_rls_test.sql: harness run passed (3 tests); caught the seeded policies'
    );
    expect(input).toContain('- supabase test db runs: 1: PASS (Tests=3)');
    expect(input).toContain('Transcript:');
  });

  it('receives the ground truth of a run that did nothing', async () => {
    const { ctx, judge } = fakeCtx([], {
      stack: 'down',
      files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL },
      history: [SEEDED_MIGRATION_VERSION],
      tests: null,
    });
    await scorer(ctx);
    const input = judgeCall(judge, 'report')?.input ?? '';
    expect(input).toContain('- local stack: none (');
    expect(input).toContain('- reads of the probe notes: unavailable (');
    expect(input).toContain('- migrations touching the notes policies: none');
    expect(input).toContain(
      '- recorded in the local migration history: n/a (no migration touches the notes policies)'
    );
    expect(input).toContain('- test files under supabase/tests: unknown (');
    expect(input).toContain('- supabase test db runs: none');
  });

  it('shows the other user reading the owner notes while the leak is still there', async () => {
    const { ctx, judge } = fakeCtx(SETUP.slice(0, 2), {
      access: withBlankLines(LEAKY_ROWS),
      files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL },
      history: [SEEDED_MIGRATION_VERSION],
      tests: { 'notes_rls_test.sql': FAILING },
    });
    await scorer(ctx);
    const input = judgeCall(judge, 'report')?.input ?? '';
    expect(input).toContain(
      '- reads of the probe notes: owner sees eval-probe-other-1, eval-probe-owner-1, eval-probe-owner-2; other user sees eval-probe-other-1, eval-probe-owner-1, eval-probe-owner-2; anon sees nothing'
    );
    expect(input).toContain('harness run failed (');
    expect(input).toContain('- supabase test db runs: none');
  });

  it('says a passing file did not catch the seeded policies', async () => {
    const { ctx, judge } = fakeCtx(SETUP, {
      tests: { 'notes_rls_test.sql': BLIND },
    });
    await scorer(ctx);
    const input = judgeCall(judge, 'report')?.input ?? '';
    expect(input).toContain(
      '- test file supabase/tests/notes_rls_test.sql: harness run passed (3 tests); did not catch the seeded policies'
    );
  });

  it('says the history is unknown, never recorded, when the stack is down', async () => {
    const { ctx, judge } = fakeCtx(SETUP.slice(1, 3), { stack: 'down' });
    await scorer(ctx);
    const input = judgeCall(judge, 'report')?.input ?? '';
    expect(input).toContain(
      '- recorded in the local migration history: unknown ('
    );
    expect(
      groundTruthLines(input).filter((line) => /: yes\b/.test(line))
    ).toEqual([]);
  });

  it('states the unrecorded fix migration without saying it was recorded', async () => {
    const { ctx, judge } = fakeCtx(SETUP.slice(0, 3), {
      history: [SEEDED_MIGRATION_VERSION],
    });
    await scorer(ctx);
    const input = judgeCall(judge, 'report')?.input ?? '';
    expect(input).toContain(
      `- recorded in the local migration history: no (version(s) ${FIX_VERSION} not in supabase_migrations.schema_migrations)`
    );
  });

  it('never carries the stack credentials', async () => {
    const { ctx, judge } = fakeCtx(SETUP);
    await scorer(ctx);
    const input = judgeCall(judge, 'report')?.input ?? '';
    expect(input).not.toContain('postgres:postgres@');
  });

  it('receives the tool outputs in the transcript', async () => {
    const { ctx, judge } = fakeCtx(SETUP, {
      transcript: [
        {
          type: 'tool_call',
          name: 'shell',
          input: { command: 'supabase test db' },
          output: 'error running container: exit 1',
        },
      ],
    });
    await scorer(ctx);
    const input = judgeCall(judge, 'report')?.input ?? '';
    expect(input).toContain('error running container: exit 1');
  });

  it('states the installed CLI and the override runners the agent used', async () => {
    const { ctx, judge } = fakeCtx([
      call('npx --yes supabase@2.1.0 start'),
      ...SETUP.slice(1),
    ]);
    await scorer(ctx);
    const input = judgeCall(judge, 'report')?.input ?? '';
    expect(input).toContain('- installed CLI: 2.0.0;');
    expect(input).toContain(
      '- agent ran npx --yes supabase@2.1.0; scorer uses the installed CLI'
    );
  });

  it('carries the rubric clauses that keep the verdict on the tests and the fix', async () => {
    const { ctx, judge } = fakeCtx(SETUP);
    await scorer(ctx);
    const rubric = judgeCall(judge, 'report')?.rubric ?? '';
    for (const clause of [
      'truthful',
      'migration history',
      'supabase test db',
      'different Supabase CLI build than the installed one',
    ]) {
      expect(rubric).toContain(clause);
    }
  });

  it('records the verdict notes and fails when the judge fails', async () => {
    const { ctx } = fakeCtx(SETUP, {
      judge: async (args) =>
        isReportCall(args)
          ? { passed: false, notes: 'report claims the tests pass' }
          : { passed: true },
    });
    expect(await checkOf(ctx, REPORT)).toMatchObject({
      passed: false,
      judgeNotes: 'report claims the tests pass',
    });
    expect(await failedNames(ctx)).toEqual([REPORT]);
  });

  it('fails only this check when the judge throws', async () => {
    const { ctx } = fakeCtx(SETUP, {
      judge: async (args) => {
        if (isReportCall(args)) throw new Error('judge unavailable');
        return { passed: true };
      },
    });
    expect(await checkOf(ctx, REPORT)).toEqual({
      name: REPORT,
      passed: false,
      notes: 'judge unavailable',
    });
    expect(await failedNames(ctx)).toEqual([REPORT]);
  });
});
