// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-002-rls-policy-tests
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
import { splitStatements } from './migrations.js';
import { buildSnapshotSql } from './snapshot.js';

const WS = '/ws';
const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const MUTATION_MARKER = 'eval-mutation-applied';
const SAFE_MARKER = 'eval-safe-mutation-applied';
const SAFE_RESTRICTIVE_MARKER = 'eval-safe-restrictive-mutation-applied';

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

const HARDEN_FILE = '20260103000000_harden_notes.sql';
const HARDEN_VERSION = '20260103000000';
const WRONG_NAME_DROP =
  'drop policy if exists "Enable read access for all users" on public.notes;\n';
const STRICT_WRONG_NAME_DROP =
  'drop policy "Enable read access for all users" on public.notes;\n';
const DO_DROP = `do $$
begin
  drop policy if exists "${LEAKY_POLICY_NAME}" on public.notes;
end $$;
`;
const DO_WRONG_NAME_DROP = `do $$
begin
  drop policy if exists "Enable read access for all users" on public.notes;
end $$;
`;
const withHarden = (sql: string) =>
  ({
    files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL, [HARDEN_FILE]: sql },
    history: [SEEDED_MIGRATION_VERSION, HARDEN_VERSION],
  }) satisfies World;

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

const ALL_TITLES = [
  'eval-probe-other-1',
  'eval-probe-owner-1',
  'eval-probe-owner-2',
];
const OWNER_TITLES = ['eval-probe-owner-1', 'eval-probe-owner-2'];
const OTHER_TITLES = ['eval-probe-other-1'];
const WRITE_ROWS = FIXED_ROWS.split('\n')
  .filter((row) => row.startsWith('write.'))
  .join('\n');

type SimulatedPolicy = {
  name: string;
  command: string;
  restrictive: boolean;
  open: boolean;
};
const POLICY_STATEMENT =
  /^(create|alter|drop) policy (if exists )?("[^"]+"|\S+) on (?:"?public"?\.)?"?notes"?\b(.*)$/;

/** What a rolled-back replay leaves the probe users reading, worked out from the replayed statements; a missing policy fails as in Postgres. */
function replayedProbe(script: string): CommandResult {
  const prefix = 'no force row level security;';
  const policies: SimulatedPolicy[] = [];
  let rowSecurity = false;
  const apply = (statement: string): void => {
    const text = statement
      .replace(/\s+/g, ' ')
      .replace(/^begin /i, '')
      .trim()
      .toLowerCase();
    const match = POLICY_STATEMENT.exec(text);
    if (match !== null) {
      const [, verb, ifExists, name, rest] = match;
      const policy = policies.find((candidate) => candidate.name === name);
      if (verb === 'create') {
        policies.push({
          name,
          command:
            /\bfor (select|insert|update|delete|all)\b/.exec(rest)?.[1] ??
            'all',
          restrictive: /\bas restrictive\b/.test(rest),
          open: /\busing \(true\)/.test(rest),
        });
      } else if (policy === undefined) {
        if (verb === 'alter' || ifExists === undefined) {
          throw new Error(`policy ${name} for table "notes" does not exist`);
        }
      } else if (verb === 'drop') {
        policies.splice(policies.indexOf(policy), 1);
      } else {
        const renamed = /^ rename to ("[^"]+"|\S+)/.exec(rest)?.[1];
        if (renamed === undefined) policy.open = /\busing \(true\)/.test(rest);
        else policy.name = renamed;
      }
    } else if (/^alter table .* row level security/.test(text)) {
      rowSecurity = /\benable row level security\b/.test(text);
    } else if (text.startsWith('do ')) {
      const body = text.slice(text.indexOf('$$') + 2, text.lastIndexOf('$$'));
      splitStatements(body).forEach(apply);
    }
  };
  try {
    splitStatements(
      script.slice(
        script.indexOf(prefix) + prefix.length,
        script.indexOf('create schema eval_probe;')
      )
    ).forEach(apply);
  } catch (error) {
    return result(
      '',
      false,
      `psql:<stdin>:31: ERROR:  ${(error as Error).message}`,
      3
    );
  }
  const visible = (own: readonly string[]) => {
    if (!rowSecurity) return ALL_TITLES;
    const select = policies.filter(
      ({ command }) => command === 'select' || command === 'all'
    );
    const permissive = select.filter(({ restrictive }) => !restrictive);
    if (permissive.length === 0) return [];
    const titles = permissive.some(({ open }) => open) ? ALL_TITLES : own;
    return select.some(({ restrictive, open }) => restrictive && !open)
      ? titles.filter((title) => own.includes(title))
      : titles;
  };
  return result(
    withBlankLines(
      [
        `read.anon|titles:${(rowSecurity ? [] : ALL_TITLES).join(',')}`,
        `read.other|titles:${visible(OTHER_TITLES).join(',')}`,
        `read.owner|titles:${visible(OWNER_TITLES).join(',')}`,
        WRITE_ROWS,
        '',
      ].join('\n')
    )
  );
}

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
type Behaviour = {
  clean: Run;
  mutated?: Run;
  safe?: Run;
  safeRestrictive?: Run;
};

const behaviourOfTap = (
  clean: string,
  leak: string,
  safe: string,
  restrictive = safe
): Behaviour => ({
  clean: { stdout: clean },
  mutated: { stdout: `${MUTATION_MARKER}\n${leak}` },
  safe: { stdout: `${SAFE_MARKER}\n${safe}` },
  safeRestrictive: { stdout: `${SAFE_RESTRICTIVE_MARKER}\n${restrictive}` },
});
const tapOf = (descriptions: readonly string[], failing: readonly number[]) =>
  [
    `1..${descriptions.length}`,
    ...descriptions.map(
      (description, i) =>
        `${failing.includes(i + 1) ? 'not ok' : 'ok'} ${i + 1} - ${description}`
    ),
    '',
  ].join('\n');

const CROSS_USER = [
  'owner sees their own notes',
  "other user sees none of the owner's notes",
  'anon sees no notes',
];
const withFirst = (first: string) => [first, ...CROSS_USER.slice(1)];
const policyChecks = (
  name: string,
  leak: readonly number[],
  safe: readonly number[],
  restrictive: readonly number[]
) =>
  behaviourOfTap(
    tapOf([name], []),
    tapOf([name], leak),
    tapOf([name], safe),
    tapOf([name], restrictive)
  );

const CATCHING = behaviourOfTap(PASSING_TAP, FAILING_TAP, PASSING_TAP);
const BLIND = behaviourOfTap(PASSING_TAP, PASSING_TAP, PASSING_TAP);
const STRUCTURAL = withFirst('notes has five policies');
const STRUCTURAL_AND_BEHAVIOURAL = behaviourOfTap(
  tapOf(STRUCTURAL, []),
  tapOf(STRUCTURAL, [1, 2]),
  tapOf(STRUCTURAL, [1])
);
const STRUCTURAL_ONLY = behaviourOfTap(
  tapOf(STRUCTURAL, []),
  tapOf(STRUCTURAL, [1]),
  tapOf(STRUCTURAL, [1])
);
const LEAKY_NAME_GONE = policyChecks(
  'no policy is named "Enable read access for authenticated users"',
  [1],
  [],
  [1]
);
const NO_TRUE_QUAL = policyChecks(
  'no policy on public.notes has qual true',
  [1],
  [],
  [1]
);
const HAS_RESTRICTIVE = policyChecks(
  'public.notes has a restrictive policy',
  [1],
  [1],
  []
);
const PER_ROW_NOTES = ['a-note-1', 'a-note-2', 'b-note-1'];
const perRow = (notes: readonly string[], plan: string | null) =>
  [
    ...(plan === null ? [] : [`1..${plan}`]),
    ...notes.map(
      (note, i) =>
        `${note.startsWith('b-') ? 'not ok' : 'ok'} ${i + 1} - a can see note: ${note}`
    ),
    ...(plan === null ? [`1..${notes.length}`] : []),
    '',
  ].join('\n');
const PER_ROW_NO_PLAN = behaviourOfTap(
  perRow(PER_ROW_NOTES.slice(0, 2), null),
  perRow(PER_ROW_NOTES, null),
  perRow(PER_ROW_NOTES.slice(0, 2), null)
);
const PER_ROW_PLAN_ONE: Behaviour = behaviourOfTap(
  '1..1\nok 1 - a can see note: a-note-1\n',
  '1..1\nok 1 - a can see note: a-note-1\nok 2 - a can see note: a-note-2\n# Looks like you planned 1 test but ran 2\n',
  '1..1\nok 1 - a can see note: a-note-1\n'
);
const SAFE_NOT_APPLIED: Behaviour = {
  ...CATCHING,
  safe: { stdout: PASSING_TAP },
};
const SAFE_RESTRICTIVE_NOT_APPLIED: Behaviour = {
  ...CATCHING,
  safeRestrictive: { stdout: PASSING_TAP },
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
      if (
        script.includes('eval_probe') &&
        script.includes('disable row level security')
      ) {
        log.push('replay');
        return replayedProbe(script);
      }
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
    if (fileArgs.includes('-')) {
      const script = scriptOf(command);
      if (script.includes(MUTATION_MARKER)) {
        log.push(`mutate ${key}`);
        return run(behaviour.mutated ?? behaviour.clean);
      }
      if (script.includes(SAFE_RESTRICTIVE_MARKER)) {
        log.push(`safe-restrictive ${key}`);
        return run(behaviour.safeRestrictive ?? behaviour.clean);
      }
      if (script.includes(SAFE_MARKER)) {
        log.push(`safe ${key}`);
        return run(behaviour.safe ?? behaviour.clean);
      }
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

  it('runs a passing file clean, under the seeded policies, then under each owner-only policy set', async () => {
    const { ctx, log } = fakeCtx(SETUP);
    await scorer(ctx);
    expect(log.filter((line) => line.endsWith(' notes_rls_test.sql'))).toEqual([
      'clean notes_rls_test.sql',
      'mutate notes_rls_test.sql',
      'safe notes_rls_test.sql',
      'safe-restrictive notes_rls_test.sql',
    ]);
  });

  it('replays the migrations once, before it runs any of the agent tests', async () => {
    const { ctx, log } = fakeCtx(SETUP);
    await scorer(ctx);
    expect(log.filter((line) => line === 'replay')).toHaveLength(1);
    expect(log.indexOf('replay')).toBeLessThan(
      log.findIndex((line) => line.startsWith('clean '))
    );
  });

  it('does not replay migrations whose files and history are not in order', async () => {
    const { ctx, log } = fakeCtx(SETUP, {
      history: [SEEDED_MIGRATION_VERSION],
    });
    await scorer(ctx);
    expect(log).not.toContain('replay');
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
      'wrote a migration that drops a differently named policy with if exists, so a reset still leaks',
      SETUP,
      withHarden(WRONG_NAME_DROP),
      [MIGRATION],
    ],
    [
      'wrote a migration whose do block drops a differently named policy, so a reset still leaks',
      SETUP,
      withHarden(DO_WRONG_NAME_DROP),
      [MIGRATION],
    ],
    [
      'removed the seeded migration and wrote a later one that only drops the leaky policy, so a reset errors',
      SETUP,
      {
        files: { [FIX_FILE]: DROP_LEAK },
        history: [FIX_VERSION],
      },
      [MIGRATION],
    ],
    [
      'removed the seeded migration and wrote a later one that only drops a policy with if exists, so notes is left open',
      SETUP,
      {
        files: { [FIX_FILE]: WRONG_NAME_DROP },
        history: [FIX_VERSION],
      },
      [MIGRATION],
    ],
    [
      'removed the seeded migration and wrote a later one that only switches row level security on, so nobody can read',
      SETUP,
      {
        files: {
          [FIX_FILE]: 'alter table public.notes enable row level security;\n',
        },
        history: [FIX_VERSION],
      },
      [MIGRATION],
    ],
    [
      'removed the seeded migration and wrote a later one that only creates owner-only policies, so a reset has no notes table',
      SETUP,
      {
        files: {
          [FIX_FILE]:
            'alter table public.notes enable row level security;\ncreate policy "Owners manage their notes" on public.notes for all to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);\n',
        },
        history: [FIX_VERSION],
      },
      [MIGRATION],
    ],
    [
      'wrote a migration that drops a policy that is not there, so a reset errors',
      SETUP,
      withHarden(STRICT_WRONG_NAME_DROP),
      [MIGRATION],
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
      'wrote tests that only check the policy set, so they fail under an owner-only policy too',
      SETUP,
      { tests: { 'notes_rls_test.sql': STRUCTURAL_ONLY } },
      [TESTS_CATCH],
    ],
    [
      'wrote a test that only checks the leaky policy name is gone, which fails once the seeded policies are kept beside a restrictive owner policy',
      SETUP,
      { tests: { 'notes_rls_test.sql': LEAKY_NAME_GONE } },
      [TESTS_CATCH],
    ],
    [
      'wrote a test that only checks no policy has qual true',
      SETUP,
      { tests: { 'notes_rls_test.sql': NO_TRUE_QUAL } },
      [TESTS_CATCH],
    ],
    [
      'wrote a test that only checks a restrictive policy exists, which a single permissive owner policy fails',
      SETUP,
      { tests: { 'notes_rls_test.sql': HAS_RESTRICTIVE } },
      [TESTS_CATCH],
    ],
    [
      'wrote tests whose owner-only policy run never printed its marker, so the run is not counted',
      SETUP,
      { tests: { 'notes_rls_test.sql': SAFE_NOT_APPLIED } },
      [TESTS_CATCH],
    ],
    [
      'wrote tests whose restrictive owner-only policy run never printed its marker, so the run is not counted',
      SETUP,
      { tests: { 'notes_rls_test.sql': SAFE_RESTRICTIVE_NOT_APPLIED } },
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
      'squashed the seeded migration into a later file that holds every policy',
      SETUP,
      {
        files: { '20260102000000_squashed.sql': `${SEEDED_SQL}\n${DROP_LEAK}` },
        history: [FIX_VERSION],
      },
    ],
    [
      'drops the leaky policy inside a do block',
      SETUP,
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [FIX_FILE]: DO_DROP,
        },
      },
    ],
    [
      'drops the leaky policy in one migration and a stray one with if exists in the next',
      SETUP,
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [FIX_FILE]: DROP_LEAK,
          [HARDEN_FILE]: WRONG_NAME_DROP,
        },
        history: [SEEDED_MIGRATION_VERSION, FIX_VERSION, HARDEN_VERSION],
      },
    ],
    [
      'mixes a structural test with behavioural ones in one file',
      SETUP,
      { tests: { 'notes_rls_test.sql': STRUCTURAL_AND_BEHAVIOURAL } },
    ],
    [
      'writes a no_plan file with one test per visible row, which fails under the leak only by an extra row',
      SETUP,
      { tests: { 'notes_rls_test.sql': PER_ROW_NO_PLAN } },
    ],
    [
      'writes a plan(1) file with one test per visible row, which fails under the leak through the plan mismatch',
      SETUP,
      { tests: { 'notes_rls_test.sql': PER_ROW_PLAN_ONE } },
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
            safe: { stdout: `${SAFE_MARKER}\n${NO_PLAN_PASSING_TAP}` },
            safeRestrictive: {
              stdout: `${SAFE_RESTRICTIVE_MARKER}\n${NO_PLAN_PASSING_TAP}`,
            },
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

  it('says a reset would still leak when the replayed migrations leave the leaky policy', async () => {
    const { ctx } = fakeCtx(SETUP, withHarden(WRONG_NAME_DROP));
    const check = await checkOf(ctx, MIGRATION);
    expect(check?.passed).toBe(false);
    expect(check?.notes).toContain(
      'replaying the migrations does not give each user only their own notes'
    );
    expect(check?.notes).toMatch(/other user.*owner/i);
  });

  it('gives the psql error when the replayed migrations fail', async () => {
    const { ctx } = fakeCtx(SETUP, withHarden(STRICT_WRONG_NAME_DROP));
    const check = await checkOf(ctx, MIGRATION);
    expect(check?.passed).toBe(false);
    expect(check?.notes).toContain('could not be replayed');
    expect(check?.notes).toContain(
      'policy "enable read access for all users" for table "notes" does not exist'
    );
  });

  it('says the replay of the migrations left each user with only their own notes', async () => {
    const { ctx } = fakeCtx(SETUP);
    const check = await checkOf(ctx, MIGRATION);
    expect(check?.passed).toBe(true);
    expect(check?.notes).toContain(
      "replaying the migrations' notes policies from the seeded state leaves each user with only their own notes"
    );
  });

  it('names the file that did not catch the seeded policies', async () => {
    const { ctx } = fakeCtx(SETUP, {
      tests: { 'notes_rls_test.sql': BLIND },
    });
    const check = await checkOf(ctx, TESTS_CATCH);
    expect(check?.passed).toBe(false);
    expect(check?.notes).toContain('supabase/tests/notes_rls_test.sql');
  });

  it('says the owner-only policy run failed too when a file only checks the policy set', async () => {
    const { ctx } = fakeCtx(SETUP, {
      tests: { 'notes_rls_test.sql': STRUCTURAL_ONLY },
    });
    const check = await checkOf(ctx, TESTS_CATCH);
    expect(check?.passed).toBe(false);
    expect(check?.notes).toContain('equivalent owner-only policy');
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
      "- reads after replaying the migrations' notes policies: owner sees eval-probe-owner-1, eval-probe-owner-2; other user sees eval-probe-other-1; anon sees nothing"
    );
    expect(input).toContain(
      "- writes after replaying the migrations' notes policies: "
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
    expect(input).toContain(
      "- reads after replaying the migrations' notes policies: unavailable ("
    );
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

  it('shows the leak surviving the replay when the migrations leave the leaky policy', async () => {
    const { ctx, judge } = fakeCtx(SETUP, withHarden(WRONG_NAME_DROP));
    await scorer(ctx);
    const input = judgeCall(judge, 'report')?.input ?? '';
    expect(input).toContain(
      "- reads after replaying the migrations' notes policies: owner sees eval-probe-other-1, eval-probe-owner-1, eval-probe-owner-2; other user sees eval-probe-other-1, eval-probe-owner-1, eval-probe-owner-2; anon sees nothing"
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
