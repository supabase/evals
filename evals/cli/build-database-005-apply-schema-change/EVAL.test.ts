// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/build-database-005-apply-schema-change
import { createHash } from 'node:crypto';
import type {
  CommandResult,
  JudgeInput,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
  ToolCallRecord,
} from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import scorer from './EVAL.js';
import { SEEDED_MIGRATION_FILE, SEEDED_MIGRATION_SHA256 } from './fixtures.js';

const WS = '/ws';
const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const SEEDED_VERSION = '20260101000000';
const SEEDED_SQL = `create table public.tasks (
  id bigint generated always as identity primary key,
  title text not null,
  done boolean not null default false,
  created_at timestamptz not null default now()
);
`;
const ADD_DUE_DATE = 'alter table public.tasks add column due_date date;\n';
const NEW_FILE = '20260102000000_add_due_date.sql';
const NEW_VERSION = '20260102000000';

const MARKER: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'beta',
  cliVersion: '2.0.0',
  docker: 'available',
  sessionStartedMs: 1_000,
};

function result(stdout: string, ok = true, stderr = ''): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr };
}

function call(command: string, cwd?: string): ToolCallRecord {
  return {
    tool: { kind: 'other', toolName: 'shell' },
    body: { command },
    command,
    ...(cwd === undefined ? {} : { cwd }),
    result: '',
    ts: 0,
  };
}

type World = {
  stack?: 'up' | 'down' | 'refusing';
  /** The CLI home the stack is registered under; the default home when unset. */
  home?: string;
  files?: Record<string, string>;
  schemas?: string[];
  column?: string;
  history?: string[];
  rows?: number;
  judge?: (args: JudgeInput) => Promise<{ passed: boolean; notes?: string }>;
  marker?: LocalStackEnvironmentMarker | 'throws';
  execThrows?: boolean;
};

const HAPPY: Required<
  Pick<World, 'stack' | 'files' | 'schemas' | 'column' | 'history' | 'rows'>
> = {
  stack: 'up',
  files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL, [NEW_FILE]: ADD_DUE_DATE },
  schemas: [],
  column: 'date|YES\n',
  history: [SEEDED_VERSION, NEW_VERSION],
  rows: 3,
};

function fakeCtx(toolCalls: ToolCallRecord[], world: World = {}) {
  const { stack, files, schemas, column, history, rows } = {
    ...HAPPY,
    ...world,
  };
  const judge = vi.fn(
    world.judge ?? (async () => ({ passed: true, notes: 'ok' }))
  );

  const homeMatches = (command: string) =>
    world.home === undefined
      ? !/(?:SUPABASE_HOME|HOME)=/.test(command)
      : command.includes(`SUPABASE_HOME='${world.home}'`);

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

    const psql = command.match(/^psql '([^']+)' -tAc ([\s\S]+)$/);
    if (psql) {
      const sql = psql[2];
      if (psql[1] !== DB_URL || stack !== 'up') {
        return result('', false, 'psql: error: connection refused');
      }
      if (sql.includes('information_schema.columns')) return result(column);
      if (sql.includes('supabase_migrations.schema_migrations')) {
        const filtered = /\bversion\s+in\s*\(/i.test(sql);
        const asked = [...sql.matchAll(/'(\d+)'/g)].map((m) => m[1]);
        const found = history.filter((v) => !filtered || asked.includes(v));
        return result(found.length > 0 ? `${found.join('\n')}\n` : '');
      }
      if (/count\(\*\)/.test(sql)) return result(`${rows}\n`);
      if (sql.includes('select 1')) return result('1\n');
    }

    if (command.includes('sha256sum')) {
      const seeded = files[SEEDED_MIGRATION_FILE];
      if (seeded === undefined) {
        return result('', false, 'sha256sum: No such file or directory');
      }
      const digest =
        seeded === SEEDED_SQL
          ? SEEDED_MIGRATION_SHA256
          : createHash('sha256').update(seeded).digest('hex');
      return result(
        `${digest}  supabase/migrations/${SEEDED_MIGRATION_FILE}\n`
      );
    }
    if (command.includes('supabase/schemas')) {
      return schemas.length === 0
        ? result('', false, 'No such file or directory')
        : result(schemas.map((path) => `supabase/schemas/${path}`).join('\n'));
    }
    if (command.includes('supabase/migrations')) {
      const cat = command.match(/^cat 'supabase\/migrations\/(.+)'$/);
      if (cat) return result(files[cat[1]] ?? '');
      const names = Object.keys(files).sort();
      return command.includes('find ')
        ? result(names.map((name) => `supabase/migrations/${name}`).join('\n'))
        : result(names.join('\n'));
    }
    return result('', false, `unexpected command: ${command}`);
  };

  const ctx = {
    workspace: WS,
    exec,
    folderExists: async (path: string) => path === 'supabase/migrations',
    toolCalls,
    transcript: [],
    environmentMarker: async () => {
      if (world.marker === 'throws') throw new Error('marker unreadable');
      return world.marker ?? MARKER;
    },
    judge,
  } as unknown as LocalStackEvalContext;
  return { ctx, judge };
}

const CHECK_NAMES = [
  'local stack is running for this project',
  'tasks.due_date exists in the local database as a nullable date or timestamp',
  'a new migration adds due_date to tasks',
  'that migration is recorded in the local migration history',
  'no container-runtime detours',
  'metrics',
  'final report is truthful about the schema change',
];

const [STACK, COLUMN, NEW_MIGRATION, RECORDED, DETOURS, METRICS, REPORT] =
  CHECK_NAMES;

const SETUP = [
  call('supabase start'),
  call(
    `cat > supabase/migrations/${NEW_FILE} <<'EOF'\nalter table public.tasks add column due_date date;\nEOF`
  ),
  call('supabase migration up'),
];

const failedNames = async (ctx: LocalStackEvalContext) =>
  ((await scorer(ctx)).checks ?? [])
    .filter(({ passed }) => !passed)
    .map(({ name }) => name);

const judgeCall = (
  judge: ReturnType<typeof fakeCtx>['judge'],
  rubricPart: string
) =>
  judge.mock.calls
    .map(([args]) => args)
    .find(({ rubric }) => rubric.includes(rubricPart));

const DETOUR_RUBRIC = 'container runtime';
const REPORT_RUBRIC = 'truthful';

describe('schema-change scorer', () => {
  it('passes a new migration applied through the CLI, in the declared check order', async () => {
    const { ctx } = fakeCtx(SETUP);
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(result.checks?.filter(({ passed }) => !passed)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('fails when any check fails', async () => {
    const { ctx } = fakeCtx(SETUP, { column: '' });
    expect((await scorer(ctx)).passed).toBe(false);
  });

  it('returns a single failing check when the scorer itself throws', async () => {
    const { ctx } = fakeCtx(SETUP, { marker: 'throws' });
    expect(await scorer(ctx)).toEqual({
      passed: false,
      checks: [
        {
          name: 'scorer evaluated the schema change',
          passed: false,
          notes: 'marker unreadable',
        },
      ],
    });
  });

  it('still reports all seven checks when every command in the sandbox throws', async () => {
    const { ctx } = fakeCtx(SETUP, { execThrows: true });
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(await failedNames(ctx)).toEqual([
      STACK,
      COLUMN,
      NEW_MIGRATION,
      RECORDED,
    ]);
  });
});

describe('known-bad runs', () => {
  it.each([
    [
      'never started the stack',
      [],
      { stack: 'down', files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL } },
      [STACK, COLUMN, NEW_MIGRATION, RECORDED],
    ],
    [
      'wrote the migration but never started the stack',
      SETUP.slice(1, 2),
      { stack: 'down' },
      [STACK, COLUMN, RECORDED],
    ],
    [
      'started the stack but its database refuses connections',
      SETUP,
      { stack: 'refusing' },
      [STACK, COLUMN, RECORDED],
    ],
    [
      'wrote the migration but never applied it',
      SETUP.slice(0, 2),
      { column: '', history: [SEEDED_VERSION] },
      [COLUMN, RECORDED],
    ],
    [
      'applied the change with psql and never wrote a file',
      [
        call('supabase start'),
        call(
          `psql "$DATABASE_URL" -c "alter table public.tasks add column due_date date"`
        ),
      ],
      {
        files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL },
        history: [SEEDED_VERSION],
      },
      [NEW_MIGRATION, RECORDED],
    ],
    [
      'wrote the migration file but applied it with psql only',
      [
        call('supabase start'),
        call(
          `psql "$DATABASE_URL" -c "alter table public.tasks add column due_date date"`
        ),
      ],
      { history: [SEEDED_VERSION] },
      [RECORDED],
    ],
    [
      'ran db diff -f after a manual change and never applied the file',
      [
        call('supabase start'),
        call(
          `psql "$DATABASE_URL" -c "alter table public.tasks add column due_date date"`
        ),
        call('supabase db diff -f add_due_date'),
      ],
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [NEW_FILE]:
            'alter table "public"."tasks" add column "due_date" date;\n',
        },
        history: [SEEDED_VERSION],
      },
      [RECORDED],
    ],
    [
      'edited the seeded migration instead of adding one',
      [call('supabase start'), call('supabase db reset')],
      {
        files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL + ADD_DUE_DATE },
        history: [SEEDED_VERSION],
      },
      [NEW_MIGRATION, RECORDED],
    ],
    [
      'named the column due_at',
      SETUP,
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [NEW_FILE]: 'alter table public.tasks add column due_at date;\n',
        },
        column: '',
      },
      [COLUMN, NEW_MIGRATION, RECORDED],
    ],
    ['made due_date text', SETUP, { column: 'text|YES\n' }, [COLUMN]],
    [
      'made due_date a NOT NULL date with a default',
      SETUP,
      { column: 'date|NO\n' },
      [COLUMN],
    ],
    [
      'wrote only a declarative schema file with no generated migration',
      [call('supabase start')],
      {
        files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL },
        schemas: ['tasks.sql'],
        history: [SEEDED_VERSION],
      },
      [NEW_MIGRATION, RECORDED],
    ],
    [
      'wrote a migration for the look-alike table tasks_archive',
      SETUP,
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [NEW_FILE]:
            'alter table public.tasks_archive add column due_date date;\n',
        },
        history: [SEEDED_VERSION],
      },
      [NEW_MIGRATION, RECORDED],
    ],
    [
      'commented the statement out',
      SETUP,
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [NEW_FILE]: `-- ${ADD_DUE_DATE}`,
        },
        history: [SEEDED_VERSION],
      },
      [NEW_MIGRATION, RECORDED],
    ],
    [
      'dropped and recreated tasks in a new migration',
      SETUP,
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [NEW_FILE]:
            'drop table public.tasks;\ncreate table public.tasks (id bigint primary key, due_date date);\n',
        },
      },
      [NEW_MIGRATION, RECORDED],
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
      'writes db diff output with quoted identifiers',
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [NEW_FILE]:
            'alter table "public"."tasks" add column "due_date" date;\n',
        },
      },
    ],
    [
      'uses timestamptz',
      {
        column: 'timestamp with time zone|YES\n',
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [NEW_FILE]:
            'alter table public.tasks add column due_date timestamptz;\n',
        },
      },
    ],
    [
      'uses a timestamp without time zone',
      { column: 'timestamp without time zone|YES\n' },
    ],
    [
      'writes alter table if exists only with add if not exists',
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [NEW_FILE]:
            'alter table if exists only tasks add if not exists due_date timestamptz',
        },
        column: 'timestamp with time zone|YES\n',
      },
    ],
    [
      'adds the column inside a multi-action alter',
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [NEW_FILE]:
            'alter table public.tasks add column priority int, add column due_date date default null;\n',
        },
      },
    ],
    [
      'generates the migration from a declarative schema',
      { schemas: ['tasks.sql'] },
    ],
    [
      'writes two matching migrations of which one is recorded',
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [NEW_FILE]: ADD_DUE_DATE,
          '20260103000000_due_date_again.sql':
            'alter table public.tasks add column if not exists due_date date;\n',
        },
        history: [SEEDED_VERSION, '20260103000000'],
      },
    ],
  ] satisfies Array<[string, World]>)(
    'passes when the agent %s',
    async (_label, world) => {
      const { ctx } = fakeCtx(SETUP, world);
      expect(await failedNames(ctx)).toEqual([]);
    }
  );

  it('passes a manual apply recorded with migration repair', async () => {
    const { ctx } = fakeCtx([
      call('supabase start'),
      call(
        `psql "$DATABASE_URL" -c "alter table public.tasks add column due_date date"`
      ),
      call(`supabase migration repair --status applied ${NEW_VERSION} --local`),
    ]);
    expect(await failedNames(ctx)).toEqual([]);
  });

  it('finds a stack the agent started under a SUPABASE_HOME it set itself', async () => {
    const home = '/home/agent/.supabase-local';
    const { ctx } = fakeCtx(
      [call(`SUPABASE_HOME=${home} supabase start`, WS), SETUP[1]],
      { home }
    );
    expect(await failedNames(ctx)).toEqual([]);
  });

  it('finds a stack under the SUPABASE_HOME the sandbox was started with', async () => {
    const home = '/sandbox/.supabase-home';
    const { ctx } = fakeCtx([call('supabase start', WS), SETUP[1]], {
      home,
      marker: { ...MARKER, env: { SUPABASE_HOME: home } },
    });
    expect(await failedNames(ctx)).toEqual([]);
  });

  it('does not find a relocated stack when nothing says where it lives', async () => {
    const { ctx } = fakeCtx(SETUP, { home: '/home/agent/.supabase-local' });
    expect(await failedNames(ctx)).toEqual([STACK, COLUMN, RECORDED]);
  });
});

describe('metrics check', () => {
  const metrics = async (ctx: LocalStackEvalContext) => {
    const check = (await scorer(ctx)).checks?.find(
      ({ name }) => name === METRICS
    );
    return JSON.parse(check?.notes ?? '{}');
  };

  it('reports the project facts of a finished run', async () => {
    const { ctx } = fakeCtx(SETUP);
    expect(await metrics(ctx)).toMatchObject({
      cliVersion: '2.0.0',
      channel: 'beta',
      backend: 'managed',
      runtime: 'native',
      workflowCommands: ['start', 'migration up'],
      directDdlCommands: 0,
      cliDetours: 0,
      seededMigrationModified: false,
      newMigrationFiles: 1,
      declarativeSchemaFiles: 0,
      taskRows: 3,
    });
  });

  it('counts the DDL the agent ran straight against the database', async () => {
    const { ctx } = fakeCtx([
      call('supabase start'),
      call(
        `psql "$DATABASE_URL" -c "alter table public.tasks add column due_date date"`
      ),
    ]);
    expect((await metrics(ctx)).directDdlCommands).toBe(1);
  });

  it('reports the edited seeded migration and the task rows it could not read', async () => {
    const { ctx } = fakeCtx(SETUP, {
      stack: 'down',
      files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL + ADD_DUE_DATE },
    });
    expect(await metrics(ctx)).toMatchObject({
      seededMigrationModified: true,
      newMigrationFiles: 0,
      backend: 'none',
      taskRows: null,
    });
  });

  it('counts the declarative schema files', async () => {
    const { ctx } = fakeCtx(SETUP, {
      schemas: ['tasks.sql', 'extra/more.sql'],
    });
    expect((await metrics(ctx)).declarativeSchemaFiles).toBe(2);
  });

  it('always passes', async () => {
    const { ctx } = fakeCtx([], { stack: 'down', execThrows: true });
    const check = (await scorer(ctx)).checks?.find(
      ({ name }) => name === METRICS
    );
    expect(check?.passed).toBe(true);
  });
});

describe('detour judge', () => {
  it('receives every command numbered and in full, with the scenario', async () => {
    const longCommand = `cat > supabase/migrations/${NEW_FILE} <<'EOF'\n${ADD_DUE_DATE.repeat(120)}EOF`;
    expect(longCommand.length).toBeGreaterThan(2000);
    const calls = [
      call('supabase start'),
      call(longCommand),
      call('supabase migration up'),
    ];
    const { ctx, judge } = fakeCtx(calls);
    await scorer(ctx);
    const sent = judgeCall(judge, DETOUR_RUBRIC);
    expect(sent?.input).toBe(
      calls.map((record, i) => `${i + 1}. ${record.command}`).join('\n')
    );
    expect(sent?.rubric).toContain('add a column the app code already uses');
    expect(sent?.rubric).toContain(
      'Running psql or other client tools against the local database'
    );
  });

  it('is not called when the agent ran no commands', async () => {
    const { ctx, judge } = fakeCtx([]);
    const check = (await scorer(ctx)).checks?.find(
      ({ name }) => name === DETOURS
    );
    expect(check).toMatchObject({ name: DETOURS, passed: true });
    expect(judgeCall(judge, DETOUR_RUBRIC)).toBeUndefined();
  });

  it('records the verdict notes and fails when the judge fails', async () => {
    const { ctx } = fakeCtx(SETUP, {
      judge: async ({ rubric }) =>
        rubric.includes(DETOUR_RUBRIC)
          ? { passed: false, notes: 'command 2 installed docker' }
          : { passed: true },
    });
    const check = (await scorer(ctx)).checks?.find(
      ({ name }) => name === DETOURS
    );
    expect(check).toMatchObject({
      passed: false,
      judgeNotes: 'command 2 installed docker',
    });
    expect(await failedNames(ctx)).toEqual([DETOURS]);
  });

  it('fails only this check when the judge throws', async () => {
    const { ctx } = fakeCtx(SETUP, {
      judge: async ({ rubric }) => {
        if (rubric.includes(DETOUR_RUBRIC))
          throw new Error('judge unavailable');
        return { passed: true };
      },
    });
    const check = (await scorer(ctx)).checks?.find(
      ({ name }) => name === DETOURS
    );
    expect(check).toEqual({
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
    const input = judgeCall(judge, REPORT_RUBRIC)?.input ?? '';
    expect(input).toContain('- project directory: /ws');
    expect(input).toContain('- local stack: resolved: managed/native');
    expect(input).toContain(
      '- tasks.due_date in the local database: date, nullable'
    );
    expect(input).toContain(
      `- new migration adding due_date: ${NEW_FILE} (version ${NEW_VERSION})`
    );
    expect(input).toContain('- recorded in the local migration history: yes');
    expect(input).toContain('- seeded migration modified: no');
    expect(input).toContain('Transcript:');
  });

  it('receives the ground truth of a run that did nothing', async () => {
    const { ctx, judge } = fakeCtx([], {
      stack: 'down',
      files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL },
    });
    await scorer(ctx);
    const input = judgeCall(judge, REPORT_RUBRIC)?.input ?? '';
    expect(input).toContain('- local stack: none (');
    expect(input).toContain(
      '- tasks.due_date in the local database: unavailable ('
    );
    expect(input).toContain(
      '- new migration adding due_date: none (no new migration adds due_date to tasks)'
    );
    expect(input).toContain('- recorded in the local migration history: no (');
  });

  it('states a column that is missing and a migration that was applied outside the history', async () => {
    const { ctx, judge } = fakeCtx(SETUP, {
      column: '',
      history: [SEEDED_VERSION],
    });
    await scorer(ctx);
    const input = judgeCall(judge, REPORT_RUBRIC)?.input ?? '';
    expect(input).toContain('- tasks.due_date in the local database: missing');
    expect(input).toContain('- recorded in the local migration history: no (');
  });

  it('states the installed CLI and the override runners the agent used', async () => {
    const { ctx, judge } = fakeCtx([
      call('npx --yes supabase@2.1.0 start'),
      ...SETUP.slice(1),
    ]);
    await scorer(ctx);
    const input = judgeCall(judge, REPORT_RUBRIC)?.input ?? '';
    expect(input).toContain('- installed CLI: 2.0.0;');
    expect(input).toContain(
      '- agent ran npx --yes supabase@2.1.0; scorer uses the installed CLI'
    );
  });

  it('carries the rubric clauses that keep the verdict on the schema change', async () => {
    const { ctx, judge } = fakeCtx(SETUP);
    await scorer(ctx);
    const rubric = judgeCall(judge, REPORT_RUBRIC)?.rubric ?? '';
    for (const clause of [
      'tasks.due_date',
      'migration history',
      'different Supabase CLI build than the installed one',
    ]) {
      expect(rubric).toContain(clause);
    }
  });

  it('records the verdict notes and fails when the judge fails', async () => {
    const { ctx } = fakeCtx(SETUP, {
      judge: async ({ rubric }) =>
        rubric.includes(REPORT_RUBRIC)
          ? { passed: false, notes: 'report claims the history has it' }
          : { passed: true },
    });
    const check = (await scorer(ctx)).checks?.find(
      ({ name }) => name === REPORT
    );
    expect(check).toMatchObject({
      passed: false,
      judgeNotes: 'report claims the history has it',
    });
    expect(await failedNames(ctx)).toEqual([REPORT]);
  });

  it('fails only this check when the judge throws', async () => {
    const { ctx } = fakeCtx(SETUP, {
      judge: async ({ rubric }) => {
        if (rubric.includes(REPORT_RUBRIC))
          throw new Error('judge unavailable');
        return { passed: true };
      },
    });
    const check = (await scorer(ctx)).checks?.find(
      ({ name }) => name === REPORT
    );
    expect(check).toEqual({
      name: REPORT,
      passed: false,
      notes: 'judge unavailable',
    });
    expect(await failedNames(ctx)).toEqual([REPORT]);
  });
});
