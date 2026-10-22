// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-001-slow-query
import { createHash } from 'node:crypto';
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
  LOOKUP_QUERY,
  SEEDED_MIGRATION_FILE,
  SEEDED_MIGRATION_SHA256,
  SEEDED_MIGRATION_VERSION,
} from './fixtures.js';

const WS = '/ws';
const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const SEEDED_SQL = `create table public.orders (
  id bigint generated always as identity primary key,
  customer_email text not null,
  status text not null default 'pending',
  total_cents integer not null,
  created_at timestamptz not null default now()
);
`;
const CREATE_INDEX =
  'create index if not exists orders_customer_email_idx on public.orders (customer_email);\n';
const NEW_FILE = '20260102000000_add_orders_customer_email_idx.sql';
const NEW_VERSION = '20260102000000';
const SECOND_FILE = '20260103000000_more_indexes.sql';
const SECOND_VERSION = '20260103000000';
const SECOND_INDEX =
  'create index if not exists orders_customer_email_again_idx on public.orders (customer_email);\n';

const MARKER: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'beta',
  cliVersion: '2.0.0',
  docker: 'available',
  sessionStartedMs: 1_000,
};

const NO_PROJECT_REF = 'Cannot find project ref. Have you run supabase link?';

const OUTLIERS = `|QUERY|EXECUTION TIME|PROPORTION OF EXEC TIME|NUMBER CALLS|SYNC IO TIME|
|-|-|-|-|-|
|\`select id, status, total_cents, created_at from public.orders where customer_email = $1 order by created_at desc limit $2\`|00:00:02.810|71.4%|200|00:00:00|
`;
const TABLE_STATS_JSON = `[{"name":"public.orders","table_size":"21 MB","index_size":"6600 kB","estimated_row_count":300000,"seq_scans":200}]`;
const UNRELATED_OUTLIERS = `|QUERY|EXECUTION TIME|PROPORTION OF EXEC TIME|NUMBER CALLS|SYNC IO TIME|
|-|-|-|-|-|
|\`select name from pg_timezone_names\`|00:00:00.120|88.0%|3|00:00:00|
`;

function result(stdout: string, ok = true, stderr = ''): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr };
}

function call(
  command: string,
  output: { result?: string; error?: string } = {}
): ToolCallRecord {
  return {
    tool: { kind: 'other', toolName: 'shell' },
    body: { command },
    command,
    result: output.result ?? '',
    ...(output.error === undefined ? {} : { error: output.error }),
    ts: 0,
  };
}

const COND = "(customer_email = 'customer-42@example.com'::text)";

type Fields = Record<string, unknown>;

const node = (type: string, fields: Fields = {}, plans: Fields[] = []) => ({
  'Node Type': type,
  'Parallel Aware': false,
  'Plan Rows': 20,
  ...fields,
  ...(plans.length === 0 ? {} : { Plans: plans }),
});

const scan = (type: string, fields: Fields = {}, plans: Fields[] = []) =>
  node(type, { 'Relation Name': 'orders', Schema: 'public', ...fields }, plans);

const explain = (root: Fields) =>
  `${JSON.stringify([{ Plan: root }], null, 2)}\n`;

const SORT = { 'Sort Key': ['created_at DESC'] };

const PLANS = {
  seqScan: explain(
    node('Limit', {}, [
      node('Sort', SORT, [scan('Seq Scan', { Filter: COND })]),
    ])
  ),
  parallelSeqScan: explain(
    node('Limit', {}, [
      node('Gather Merge', {}, [
        node('Sort', SORT, [
          scan('Seq Scan', { 'Parallel Aware': true, Filter: COND }),
        ]),
      ]),
    ])
  ),
  bitmap: explain(
    node('Limit', {}, [
      node('Sort', SORT, [
        scan('Bitmap Heap Scan', { 'Recheck Cond': COND }, [
          node('Bitmap Index Scan', {
            'Index Name': 'orders_customer_email_idx',
            'Index Cond': COND,
          }),
        ]),
      ]),
    ])
  ),
  composite: explain(
    node('Limit', {}, [
      scan('Index Scan', {
        'Index Name': 'orders_customer_email_created_at_idx',
        'Index Cond': COND,
      }),
    ])
  ),
  hash: explain(
    node('Limit', {}, [
      node('Sort', SORT, [
        scan('Index Scan', {
          'Index Name': 'orders_customer_email_hash_idx',
          'Index Cond': COND,
        }),
      ]),
    ])
  ),
  createdAtOnly: explain(
    node('Limit', {}, [
      scan('Index Scan', {
        'Scan Direction': 'Backward',
        'Index Name': 'orders_created_at_idx',
        Filter: COND,
      }),
    ])
  ),
};

const hex = (text: string) => Buffer.from(text, 'utf8').toString('hex');

type CatalogIndex = { name: string; definition: string };

const PKEY: CatalogIndex = {
  name: 'orders_pkey',
  definition:
    'CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)',
};
const EMAIL_INDEX: CatalogIndex = {
  name: 'orders_customer_email_idx',
  definition:
    'CREATE INDEX orders_customer_email_idx ON public.orders USING btree (customer_email)',
};

type World = {
  stack?: 'up' | 'down' | 'refusing';
  home?: string;
  files?: Record<string, string>;
  plan?: string | CommandResult;
  catalog?: CatalogIndex[];
  rows?: string;
  history?: string[];
  recordedStatements?: Record<string, string>;
  judge?: (args: JudgeInput) => Promise<{ passed: boolean; notes?: string }>;
  transcript?: TranscriptPart[];
  marker?: LocalStackEnvironmentMarker | 'throws';
  execThrows?: boolean;
};

const HAPPY: Required<
  Pick<World, 'stack' | 'files' | 'plan' | 'catalog' | 'rows' | 'history'>
> = {
  stack: 'up',
  files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL, [NEW_FILE]: CREATE_INDEX },
  plan: PLANS.bitmap,
  catalog: [PKEY, EMAIL_INDEX],
  rows: '300000',
  history: [SEEDED_MIGRATION_VERSION, NEW_VERSION],
};

function fakeCtx(toolCalls: ToolCallRecord[], world: World = {}) {
  const { stack, files, plan, catalog, rows, history } = {
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

    const psql = command.match(/^psql '([^']+)' -X?tAc ([\s\S]+)$/);
    if (psql) {
      const sql = psql[2];
      if (psql[1] !== DB_URL || stack !== 'up') {
        return result('', false, 'psql: error: connection refused');
      }
      if (sql.includes('explain (format json)')) {
        return typeof plan === 'string' ? result(plan) : plan;
      }
      if (sql.includes('supabase_migrations.schema_migrations')) {
        const filtered = /\bversion\s+in\s*\(/i.test(sql);
        const asked = [...sql.matchAll(/'(\d+)'/g)].map((m) => m[1]);
        const found = history
          .filter((v) => !filtered || asked.includes(v))
          .map((version) => {
            const name = Object.keys(files).find((file) =>
              file.startsWith(`${version}_`)
            );
            const statements =
              world.recordedStatements?.[version] ??
              (name === undefined ? '' : files[name]);
            return `${version}|${hex(statements)}`;
          });
        return result(found.length > 0 ? `${found.join('\n')}\n` : '');
      }
      if (sql.includes('pg_indexes')) {
        const asHex = /'hex'/.test(sql);
        const rowsOut = catalog.map(
          ({ name, definition }) =>
            `${name}|${asHex ? hex(definition) : definition}`
        );
        return result(rowsOut.length > 0 ? `${rowsOut.join('\n')}\n` : '');
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
    transcript: world.transcript ?? [],
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
  'an inspect db report showed the orders table',
  'the order-history lookup uses an index on customer_email',
  'orders still holds every seeded row',
  'a new migration creates an index on orders.customer_email',
  'that migration is recorded in the local migration history',
  'no container-runtime detours',
  'metrics',
  'final report is truthful about the cause and the fix',
];

const [
  STACK,
  INSPECT,
  PLAN,
  ROWS,
  NEW_MIGRATION,
  RECORDED,
  DETOURS,
  METRICS,
  REPORT,
] = CHECK_NAMES;

const INSPECT_CALL = call('supabase inspect db outliers --local', {
  result: OUTLIERS,
});
const WRITE_MIGRATION = call(
  `cat > supabase/migrations/${NEW_FILE} <<'EOF'\n${CREATE_INDEX}EOF`
);
const CREATE_INDEX_BY_HAND = call(
  `psql "$DATABASE_URL" -c "create index if not exists orders_customer_email_idx on public.orders (customer_email)"`
);

const SETUP = [
  call('supabase start'),
  INSPECT_CALL,
  WRITE_MIGRATION,
  call('supabase migration up'),
];

const inWorkspace = (record: ToolCallRecord): ToolCallRecord => ({
  ...record,
  cwd: WS,
});

const withInspect = (inspectCall: ToolCallRecord) => [
  SETUP[0],
  inspectCall,
  ...SETUP.slice(2),
];

const failedNames = async (ctx: LocalStackEvalContext) =>
  ((await scorer(ctx)).checks ?? [])
    .filter(({ passed }) => !passed)
    .map(({ name }) => name);

const checkOf = async (ctx: LocalStackEvalContext, name: string) =>
  (await scorer(ctx)).checks?.find((check) => check.name === name);

const DETOUR_RUBRIC = 'container runtime';
const GROUND_TRUTH_HEADER =
  'Ground truth observed by the harness after the run:';

const isReportJudge = ({ input }: JudgeInput) =>
  input.startsWith(GROUND_TRUTH_HEADER);

const judgeCalls = (judge: ReturnType<typeof fakeCtx>['judge']) =>
  judge.mock.calls.map(([args]) => args);

const detourCall = (judge: ReturnType<typeof fakeCtx>['judge']) =>
  judgeCalls(judge).find(({ rubric }) => rubric.includes(DETOUR_RUBRIC));

const reportCall = (judge: ReturnType<typeof fakeCtx>['judge']) =>
  judgeCalls(judge).find(isReportJudge);

const mentionsApplied = (line: string) => /applied/i.test(line);
const groundTruthLines = (input: string) =>
  input.split('\nTranscript:')[0].split('\n');

describe('slow-query scorer', () => {
  it('passes a run that found the cause with inspect and shipped an applied index migration, in the declared check order', async () => {
    const { ctx } = fakeCtx(SETUP);
    const scored = await scorer(ctx);
    expect(scored.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(scored.checks?.filter(({ passed }) => !passed)).toEqual([]);
    expect(scored.passed).toBe(true);
  });

  it('fails when any check fails', async () => {
    const { ctx } = fakeCtx(SETUP, { rows: '0' });
    expect((await scorer(ctx)).passed).toBe(false);
  });

  it('returns a single failing check when the scorer itself throws', async () => {
    const { ctx } = fakeCtx(SETUP, { marker: 'throws' });
    expect(await scorer(ctx)).toEqual({
      passed: false,
      checks: [
        {
          name: 'scorer evaluated the slow-query fix',
          passed: false,
          notes: 'marker unreadable',
        },
      ],
    });
  });

  it('still reports all nine checks when every command in the sandbox throws', async () => {
    const { ctx } = fakeCtx(SETUP, { execThrows: true });
    const scored = await scorer(ctx);
    expect(scored.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(await failedNames(ctx)).toEqual([
      STACK,
      PLAN,
      ROWS,
      NEW_MIGRATION,
      RECORDED,
    ]);
  });

  it('fails the checks that need a database with the reason when the stack is down, without throwing', async () => {
    const { ctx } = fakeCtx(SETUP, { stack: 'down' });
    expect(await failedNames(ctx)).toEqual([STACK, PLAN, ROWS, RECORDED]);
    for (const name of [STACK, PLAN, ROWS, RECORDED]) {
      expect((await checkOf(ctx, name))?.notes).toContain('no stack running');
    }
  });

  it('says in the plan check which index the lookup uses', async () => {
    const { ctx } = fakeCtx(SETUP);
    const check = await checkOf(ctx, PLAN);
    expect(check?.passed).toBe(true);
    expect(check?.notes).toContain('orders_customer_email_idx');
  });

  it('says in the plan check that the lookup still scans orders sequentially', async () => {
    const { ctx } = fakeCtx(SETUP, { plan: PLANS.seqScan });
    const check = await checkOf(ctx, PLAN);
    expect(check?.passed).toBe(false);
    expect(check?.notes).toMatch(/seq scan/i);
  });

  it('says in the rows check how many rows are left', async () => {
    const { ctx } = fakeCtx(SETUP, { rows: '1000' });
    const check = await checkOf(ctx, ROWS);
    expect(check?.passed).toBe(false);
    expect(check?.notes).toContain('1000');
  });

  it('says in the migration check which file and version create the index', async () => {
    const { ctx } = fakeCtx(SETUP);
    const check = await checkOf(ctx, NEW_MIGRATION);
    expect(check?.passed).toBe(true);
    expect(check?.notes).toContain(`${NEW_FILE} (version ${NEW_VERSION})`);
  });

  it('says in the inspect check which tool call ran the report', async () => {
    const { ctx } = fakeCtx(SETUP);
    const check = await checkOf(ctx, INSPECT);
    expect(check?.passed).toBe(true);
    expect(check?.notes).toContain('tool call 2: supabase inspect db outliers');
  });
});

describe('known-bad runs', () => {
  it.each([
    [
      'never started the stack',
      [],
      { stack: 'down', files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL } },
      [STACK, INSPECT, PLAN, ROWS, NEW_MIGRATION, RECORDED],
    ],
    [
      'wrote the migration but never started the stack',
      [WRITE_MIGRATION],
      { stack: 'down' },
      [STACK, INSPECT, PLAN, ROWS, RECORDED],
    ],
    [
      'started the stack but its database refuses connections',
      SETUP,
      { stack: 'refusing' },
      [STACK, PLAN, ROWS, RECORDED],
    ],
    [
      'wrote the migration but never applied it',
      SETUP.slice(0, 3),
      {
        plan: PLANS.seqScan,
        catalog: [PKEY],
        history: [SEEDED_MIGRATION_VERSION],
      },
      [PLAN, RECORDED],
    ],
    [
      'inspected the database and then did nothing about it',
      SETUP.slice(0, 2),
      {
        files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL },
        plan: PLANS.seqScan,
        catalog: [PKEY],
        history: [SEEDED_MIGRATION_VERSION],
      },
      [PLAN, NEW_MIGRATION, RECORDED],
    ],
    [
      'created the index with psql and never wrote a file',
      [SETUP[0], INSPECT_CALL, CREATE_INDEX_BY_HAND],
      {
        files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL },
        history: [SEEDED_MIGRATION_VERSION],
      },
      [NEW_MIGRATION, RECORDED],
    ],
    [
      'wrote the migration file but created the index with psql only',
      [SETUP[0], INSPECT_CALL, WRITE_MIGRATION, CREATE_INDEX_BY_HAND],
      { history: [SEEDED_MIGRATION_VERSION] },
      [RECORDED],
    ],
    [
      'edited the seeded migration instead of adding one',
      [SETUP[0], INSPECT_CALL, call('supabase db reset')],
      {
        files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL + CREATE_INDEX },
        history: [SEEDED_MIGRATION_VERSION],
      },
      [NEW_MIGRATION, RECORDED],
    ],
    [
      'indexed created_at only',
      SETUP,
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [NEW_FILE]:
            'create index orders_created_at_idx on public.orders (created_at);\n',
        },
        plan: PLANS.createdAtOnly,
      },
      [PLAN, NEW_MIGRATION, RECORDED],
    ],
    [
      'indexed lower(customer_email)',
      SETUP,
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [NEW_FILE]:
            'create index orders_email_lower_idx on public.orders (lower(customer_email));\n',
        },
        plan: PLANS.seqScan,
      },
      [PLAN, NEW_MIGRATION, RECORDED],
    ],
    [
      'indexed (created_at, customer_email) with customer_email second',
      SETUP,
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [NEW_FILE]:
            'create index orders_created_email_idx on public.orders (created_at, customer_email);\n',
        },
        plan: PLANS.seqScan,
      },
      [PLAN, NEW_MIGRATION, RECORDED],
    ],
    [
      'left the lookup on a parallel sequential scan',
      SETUP,
      { plan: PLANS.parallelSeqScan },
      [PLAN],
    ],
    [
      'renamed the column so the probe query errors',
      SETUP,
      {
        plan: result(
          '',
          false,
          'ERROR:  column "customer_email" does not exist'
        ),
      },
      [PLAN],
    ],
    ['truncated the table', SETUP, { rows: '0' }, [ROWS]],
    ['deleted most of the rows', SETUP, { rows: '1000' }, [ROWS]],
    [
      'indexed the look-alike table orders_archive',
      SETUP,
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [NEW_FILE]:
            'create index on public.orders_archive (customer_email);\n',
        },
        plan: PLANS.seqScan,
      },
      [PLAN, NEW_MIGRATION, RECORDED],
    ],
    [
      'indexed the look-alike table private.orders',
      SETUP,
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [NEW_FILE]: 'create index on private.orders (customer_email);\n',
        },
        plan: PLANS.seqScan,
      },
      [PLAN, NEW_MIGRATION, RECORDED],
    ],
    [
      'wrote the migration with a date older than the seeded one',
      SETUP,
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          '20250101000000_idx.sql': CREATE_INDEX,
        },
        history: [SEEDED_MIGRATION_VERSION, '20250101000000'],
      },
      [NEW_MIGRATION, RECORDED],
    ],
    [
      'commented the statement out',
      SETUP,
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [NEW_FILE]: `-- ${CREATE_INDEX}`,
        },
        plan: PLANS.seqScan,
      },
      [PLAN, NEW_MIGRATION, RECORDED],
    ],
    [
      'put the statement inside a function body',
      SETUP,
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [NEW_FILE]:
            'create function public.make_idx() returns void language sql as $$ create index on public.orders (customer_email) $$;\n',
        },
        plan: PLANS.seqScan,
      },
      [PLAN, NEW_MIGRATION, RECORDED],
    ],
    [
      'wrote a unique index the data cannot satisfy and could not apply it',
      SETUP,
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [NEW_FILE]:
            'create unique index orders_customer_email_key on public.orders (customer_email);\n',
        },
        plan: PLANS.seqScan,
        history: [SEEDED_MIGRATION_VERSION],
      },
      [PLAN, RECORDED],
    ],
    [
      'applied an empty migration file, then filled it and created the index by hand',
      [
        SETUP[0],
        INSPECT_CALL,
        call('supabase migration new add_orders_customer_email_idx'),
        call('supabase migration up'),
        CREATE_INDEX_BY_HAND,
      ],
      { recordedStatements: { [NEW_VERSION]: '' } },
      [RECORDED],
    ],
    [
      'wrote two migrations that create the index and applied only the first',
      SETUP,
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [NEW_FILE]: CREATE_INDEX,
          [SECOND_FILE]: SECOND_INDEX,
        },
        history: [SEEDED_MIGRATION_VERSION, NEW_VERSION],
      },
      [RECORDED],
    ],
  ] satisfies Array<[string, ToolCallRecord[], World, string[]]>)(
    'fails only the checks the run got wrong when it %s',
    async (_label, toolCalls, world, expected) => {
      const { ctx } = fakeCtx(toolCalls, world);
      expect(await failedNames(ctx)).toEqual(expected);
    }
  );
});

describe('inspect evidence', () => {
  it.each([
    [
      'ran the default report with no project linked and was refused',
      call('supabase inspect db outliers', { error: NO_PROJECT_REF }),
    ],
    [
      'read pg_stat_statements through psql',
      call(
        `psql "$DATABASE_URL" -c "select query, calls from pg_stat_statements order by total_exec_time desc"`,
        { result: 'select ... from public.orders where customer_email = $1' }
      ),
    ],
    [
      'read pg_stat_statements through db query',
      call(`supabase db query --local "select query from pg_stat_statements"`, {
        result: 'select ... from public.orders where customer_email = $1',
      }),
    ],
    [
      'only asked inspect for help',
      call('supabase inspect db --help', {
        result: 'Usage: supabase inspect db [command]\n  outliers  orders ...',
      }),
    ],
    [
      'only echoed the inspect command',
      call('echo "supabase inspect db outliers"', {
        result: 'supabase inspect db outliers (public.orders)',
      }),
    ],
    [
      'ran a report that never mentioned orders',
      call('supabase inspect db outliers --local', {
        result: UNRELATED_OUTLIERS,
      }),
    ],
  ] satisfies Array<[string, ToolCallRecord]>)(
    'fails only the inspect check when the agent %s',
    async (_label, inspectCall) => {
      const { ctx } = fakeCtx(withInspect(inspectCall));
      expect(await failedNames(ctx)).toEqual([INSPECT]);
    }
  );

  it('says in the inspect check that no report ran when the agent ran none', async () => {
    const { ctx } = fakeCtx([SETUP[0], ...SETUP.slice(2)]);
    expect(await checkOf(ctx, INSPECT)).toEqual({
      name: INSPECT,
      passed: false,
      notes: 'no supabase inspect report ran',
    });
  });

  it.each([
    [
      'table-stats as JSON',
      call('supabase inspect db table-stats --local -o json', {
        result: TABLE_STATS_JSON,
      }),
    ],
    [
      'calls through a package runner and a pipe',
      call('npx supabase@beta inspect db calls --local | head -40', {
        result: OUTLIERS,
      }),
    ],
    [
      'outliers over a connection string in JSON',
      call(
        `supabase inspect db outliers --db-url ${DB_URL} --output-format json`,
        { result: OUTLIERS }
      ),
    ],
    [
      'the deprecated seq-scans alias',
      call('supabase inspect db seq-scans --local', {
        result: TABLE_STATS_JSON,
      }),
    ],
    [
      'a report written to disk and read back in the same call',
      call(
        'supabase inspect report --local --output-dir /tmp/r && cat /tmp/r/*/outliers.csv',
        { result: 'query,calls\nselect ... from public.orders ...,200\n' }
      ),
    ],
  ] satisfies Array<[string, ToolCallRecord]>)(
    'passes when the agent used %s',
    async (_label, inspectCall) => {
      const { ctx } = fakeCtx(withInspect(inspectCall));
      expect(await failedNames(ctx)).toEqual([]);
    }
  );

  it('passes when the first report was refused and a later --local report showed orders', async () => {
    const { ctx } = fakeCtx([
      SETUP[0],
      call('supabase inspect db outliers', { error: NO_PROJECT_REF }),
      INSPECT_CALL,
      ...SETUP.slice(2),
    ]);
    expect(await failedNames(ctx)).toEqual([]);
  });
});

describe('valid alternatives', () => {
  it.each([
    [
      'writes db diff output with quoted identifiers',
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [NEW_FILE]:
            'CREATE INDEX "orders_customer_email_idx" ON "public"."orders" USING btree ("customer_email");\n',
        },
      },
    ],
    [
      'creates the index concurrently',
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [NEW_FILE]:
            'create index concurrently if not exists orders_customer_email_idx on public.orders (customer_email);\n',
        },
      },
    ],
    [
      'indexes (customer_email, created_at desc)',
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [NEW_FILE]:
            'create index on orders(customer_email, created_at desc);\n',
        },
        plan: PLANS.composite,
      },
    ],
    [
      'uses a hash index',
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [NEW_FILE]:
            'create index orders_customer_email_hash_idx on public.orders using hash (customer_email);\n',
        },
        plan: PLANS.hash,
      },
    ],
    [
      'adds a covering index',
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [NEW_FILE]:
            'create index orders_customer_email_idx on public.orders (customer_email) include (status, total_cents);\n',
        },
      },
    ],
    [
      'writes two migrations that create the index and applies both',
      {
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [NEW_FILE]: CREATE_INDEX,
          [SECOND_FILE]: SECOND_INDEX,
        },
        history: [SEEDED_MIGRATION_VERSION, NEW_VERSION, SECOND_VERSION],
      },
    ],
    ['leaves 300001 rows after a test insert', { rows: '300001' }],
  ] satisfies Array<[string, World]>)(
    'passes when the agent %s',
    async (_label, world) => {
      const { ctx } = fakeCtx(SETUP, world);
      expect(await failedNames(ctx)).toEqual([]);
    }
  );

  it('passes when the agent explains the lookup through psql while investigating', async () => {
    const { ctx } = fakeCtx([
      SETUP[0],
      INSPECT_CALL,
      call(`psql "$DATABASE_URL" -c "explain analyze ${LOOKUP_QUERY}"`),
      ...SETUP.slice(2),
    ]);
    expect(await failedNames(ctx)).toEqual([]);
  });

  it.each([
    ['db reset', 'supabase db reset'],
    ['db push --local', 'supabase db push --local'],
  ])(
    'passes when the agent applies the file with %s',
    async (_label, apply) => {
      const { ctx } = fakeCtx([...SETUP.slice(0, 3), call(apply)]);
      expect(await failedNames(ctx)).toEqual([]);
    }
  );

  it('passes a manual apply recorded with migration repair', async () => {
    const { ctx } = fakeCtx([
      SETUP[0],
      INSPECT_CALL,
      WRITE_MIGRATION,
      CREATE_INDEX_BY_HAND,
      call(`supabase migration repair --status applied ${NEW_VERSION} --local`),
    ]);
    expect(await failedNames(ctx)).toEqual([]);
  });

  it('passes when the recorded statements match the file apart from formatting', async () => {
    const { ctx } = fakeCtx(SETUP, {
      recordedStatements: {
        [NEW_VERSION]:
          '-- index the lookup\nCREATE INDEX IF NOT EXISTS orders_customer_email_idx\n  ON public.orders (customer_email)',
      },
    });
    expect(await failedNames(ctx)).toEqual([]);
  });

  it('finds a stack the agent started under a SUPABASE_HOME it set itself', async () => {
    const home = '/home/agent/.supabase-local';
    const { ctx } = fakeCtx(
      [
        inWorkspace(call(`SUPABASE_HOME=${home} supabase start`)),
        ...SETUP.slice(1),
      ],
      { home }
    );
    expect(await failedNames(ctx)).toEqual([]);
  });

  it('finds a stack under the SUPABASE_HOME the sandbox was started with', async () => {
    const home = '/sandbox/.supabase-home';
    const { ctx } = fakeCtx([inWorkspace(SETUP[0]), ...SETUP.slice(1)], {
      home,
      marker: { ...MARKER, env: { SUPABASE_HOME: home } },
    });
    expect(await failedNames(ctx)).toEqual([]);
  });

  it('does not find a relocated stack when nothing says where it lives', async () => {
    const { ctx } = fakeCtx(SETUP, { home: '/home/agent/.supabase-local' });
    expect(await failedNames(ctx)).toEqual([STACK, PLAN, ROWS, RECORDED]);
  });
});

describe('metrics check', () => {
  const metrics = async (ctx: LocalStackEvalContext) => {
    const check = await checkOf(ctx, METRICS);
    return JSON.parse(check?.notes ?? '{}');
  };

  it('reports the facts of a finished run', async () => {
    const { ctx } = fakeCtx(SETUP);
    expect(await metrics(ctx)).toEqual({
      cliVersion: '2.0.0',
      cliOverride: [],
      channel: 'beta',
      backend: 'managed',
      runtime: 'native',
      relocatedHome: null,
      dbPort: 54322,
      inspectReports: ['db outliers'],
      inspectRuns: 1,
      inspectRunsShowingOrders: 1,
      workflowCommands: ['start', 'inspect db outliers', 'migration up'],
      explainCommands: 0,
      directIndexDdl: 0,
      ordersIndexes: ['orders_pkey', 'orders_customer_email_idx'],
      orderRows: 300_000,
      newMigrationFiles: 1,
      seededMigrationModified: false,
      cliDetours: 0,
    });
  });

  it('counts the plans the agent explained and the index it created straight against the database', async () => {
    const { ctx } = fakeCtx([
      SETUP[0],
      INSPECT_CALL,
      call(`psql "$DATABASE_URL" -c "explain ${LOOKUP_QUERY}"`),
      CREATE_INDEX_BY_HAND,
    ]);
    expect(await metrics(ctx)).toMatchObject({
      explainCommands: 1,
      directIndexDdl: 1,
    });
  });

  it('reports the edited seeded migration and the facts it could not read when no stack is up', async () => {
    const { ctx } = fakeCtx(SETUP, {
      stack: 'down',
      files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL + CREATE_INDEX },
    });
    expect(await metrics(ctx)).toMatchObject({
      seededMigrationModified: true,
      newMigrationFiles: 0,
      backend: 'none',
      dbPort: null,
      ordersIndexes: null,
      orderRows: null,
    });
  });

  it('reports the inspect reports that ran and how many showed orders', async () => {
    const { ctx } = fakeCtx([
      SETUP[0],
      call('supabase inspect db outliers', { error: NO_PROJECT_REF }),
      call('supabase inspect db calls --local', { result: UNRELATED_OUTLIERS }),
      call('supabase inspect db table-stats --local', {
        result: TABLE_STATS_JSON,
      }),
      ...SETUP.slice(2),
    ]);
    expect(await metrics(ctx)).toMatchObject({
      inspectReports: ['db outliers', 'db calls', 'db table-stats'],
      inspectRuns: 3,
      inspectRunsShowingOrders: 1,
    });
  });

  it('always passes', async () => {
    const { ctx } = fakeCtx([], { stack: 'down', execThrows: true });
    expect((await checkOf(ctx, METRICS))?.passed).toBe(true);
  });
});

describe('detour judge', () => {
  it('receives every command numbered and in full, with the scenario', async () => {
    const longCommand = `cat > supabase/migrations/${NEW_FILE} <<'EOF'\n${CREATE_INDEX.repeat(60)}EOF`;
    expect(longCommand.length).toBeGreaterThan(2000);
    const calls = [SETUP[0], INSPECT_CALL, call(longCommand), SETUP[3]];
    const { ctx, judge } = fakeCtx(calls);
    await scorer(ctx);
    const sent = detourCall(judge);
    expect(sent?.input).toBe(
      calls.map((record, i) => `${i + 1}. ${record.command}`).join('\n')
    );
    expect(sent?.rubric).toContain('find what is slow');
    expect(sent?.rubric).toContain(
      'Running psql, EXPLAIN or other client tools against the local database'
    );
    expect(sent?.rubric).toContain('supabase inspect');
  });

  it('is not called when the agent ran no commands', async () => {
    const { ctx, judge } = fakeCtx([]);
    expect(await checkOf(ctx, DETOURS)).toMatchObject({
      name: DETOURS,
      passed: true,
    });
    expect(detourCall(judge)).toBeUndefined();
  });

  it('records the verdict notes and fails when the judge fails', async () => {
    const { ctx } = fakeCtx(SETUP, {
      judge: async (args) =>
        isReportJudge(args)
          ? { passed: true }
          : { passed: false, notes: 'command 2 installed docker' },
    });
    expect(await checkOf(ctx, DETOURS)).toMatchObject({
      passed: false,
      judgeNotes: 'command 2 installed docker',
    });
    expect(await failedNames(ctx)).toEqual([DETOURS]);
  });

  it('fails only this check when the judge throws', async () => {
    const { ctx } = fakeCtx(SETUP, {
      judge: async (args) => {
        if (!isReportJudge(args)) throw new Error('judge unavailable');
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
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain('- project directory: /ws');
    expect(input).toContain('- local stack: resolved: managed/native');
    expect(input).toContain('- what the seed made slow:');
    expect(input).toContain('- rows in public.orders: 300000 (seeded 300000)');
    expect(input).toMatch(
      /- order-history lookup plan now: .*orders_customer_email_idx/
    );
    expect(input).toContain(
      `- new migrations creating an index on orders.customer_email: ${NEW_FILE} (version ${NEW_VERSION})`
    );
    expect(input).toContain('- recorded in the local migration history: yes');
    expect(input).toContain(
      '- supabase inspect reports the agent ran: tool call 2: db outliers (showed orders)'
    );
    expect(input).toContain('- seeded migration modified: no');
    expect(input).toContain('Transcript:');
  });

  it('receives the ground truth of a run that did nothing', async () => {
    const { ctx, judge } = fakeCtx([], {
      stack: 'down',
      files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL },
    });
    await scorer(ctx);
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain('- local stack: none (');
    expect(input).toContain('- order-history lookup plan now: unavailable (');
    expect(input).toContain('- rows in public.orders: unavailable (');
    expect(input).toContain(
      '- new migrations creating an index on orders.customer_email: none ('
    );
    expect(input).toContain(
      '- recorded in the local migration history: unknown ('
    );
    expect(input).toContain('- supabase inspect reports the agent ran: none');
  });

  it('shows the sequential scan when the index never reached the database', async () => {
    const { ctx, judge } = fakeCtx(SETUP.slice(0, 3), {
      plan: PLANS.seqScan,
      catalog: [PKEY],
      history: [SEEDED_MIGRATION_VERSION],
    });
    await scorer(ctx);
    const truth = groundTruthLines(reportCall(judge)?.input ?? '');
    const planLine = truth.find((entry) =>
      entry.startsWith('- order-history lookup plan now:')
    );
    const indexesLine = truth.find((entry) =>
      entry.startsWith('- indexes on public.orders:')
    );
    expect(planLine).toMatch(/seq scan on orders/i);
    expect(planLine).not.toContain('orders_customer_email_idx');
    expect(indexesLine).toBe(
      `- indexes on public.orders: ${PKEY.name}: ${PKEY.definition}`
    );
  });

  it('receives the tool outputs in the transcript', async () => {
    const { ctx, judge } = fakeCtx(SETUP, {
      transcript: [
        {
          type: 'tool_call',
          name: 'shell',
          input: { command: 'supabase inspect db outliers --local' },
          output: 'toomanyrequests: Rate exceeded',
        },
      ],
    });
    await scorer(ctx);
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain('supabase inspect db outliers --local');
    expect(input).toContain('toomanyrequests: Rate exceeded');
  });

  it('says the history is unknown, never applied, when the stack is down and a migration was written', async () => {
    const { ctx, judge } = fakeCtx([WRITE_MIGRATION], { stack: 'down' });
    await scorer(ctx);
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain(
      '- recorded in the local migration history: unknown ('
    );
    expect(groundTruthLines(input).filter(mentionsApplied)).toEqual([]);
  });

  it('says the migration is not in the history, never applied, when it was written but not run', async () => {
    const { ctx, judge } = fakeCtx(SETUP.slice(0, 3), {
      plan: PLANS.seqScan,
      history: [SEEDED_MIGRATION_VERSION],
    });
    await scorer(ctx);
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain('- recorded in the local migration history: no (');
    expect(input).toContain(NEW_VERSION);
    expect(groundTruthLines(input).filter(mentionsApplied)).toEqual([]);
  });

  it('says the history has the version with statements that lack the index', async () => {
    const { ctx, judge } = fakeCtx(SETUP, {
      recordedStatements: { [NEW_VERSION]: '' },
    });
    await scorer(ctx);
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain('- recorded in the local migration history: no (');
    expect(input).toMatch(/statements/);
  });

  it('states the installed CLI and the override runners the agent used', async () => {
    const { ctx, judge } = fakeCtx([
      call('npx --yes supabase@2.1.0 start'),
      ...SETUP.slice(1),
    ]);
    await scorer(ctx);
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain('- installed CLI: 2.0.0;');
    expect(input).toContain(
      '- agent ran npx --yes supabase@2.1.0; scorer uses the installed CLI'
    );
  });

  it('carries the rubric clauses that keep the verdict on the cause and the fix', async () => {
    const { ctx, judge } = fakeCtx(SETUP);
    await scorer(ctx);
    const rubric = reportCall(judge)?.rubric ?? '';
    for (const clause of [
      /customer_email/,
      /bloat/i,
      /vacuum/i,
      /lock/i,
      /connection limits/i,
      /primary[- ]key/i,
      /migration/i,
      /different Supabase CLI build than the installed one/,
    ]) {
      expect(rubric).toMatch(clause);
    }
  });

  it('records the verdict notes and fails when the judge fails', async () => {
    const { ctx } = fakeCtx(SETUP, {
      judge: async (args) =>
        isReportJudge(args)
          ? { passed: false, notes: 'report blames vacuum' }
          : { passed: true },
    });
    expect(await checkOf(ctx, REPORT)).toMatchObject({
      passed: false,
      judgeNotes: 'report blames vacuum',
    });
    expect(await failedNames(ctx)).toEqual([REPORT]);
  });

  it('fails only this check when the judge throws', async () => {
    const { ctx } = fakeCtx(SETUP, {
      judge: async (args) => {
        if (isReportJudge(args)) throw new Error('judge unavailable');
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
