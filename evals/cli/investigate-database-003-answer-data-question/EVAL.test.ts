// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-003-answer-data-question
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
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import {
  DETOUR_CHECK_NAME,
  extractCommandEntries,
  formatDetourJudgeInput,
} from '../lib/detours.js';
import {
  ANSWER_SOURCE_CHECK,
  findDbQueryRuns,
  findSavedOutputReads,
  formatAnswerSourceJudgeInput,
  REPLY_CHECK,
} from './answer.js';
import { DATA_CHECK, SEEDED_DATA_SQL } from './data.js';
import scorer from './EVAL.js';
import { FALLBACK_CHECK, FALLBACK_RUBRIC } from './fallback.js';
import { SEEDED } from './fixtures.js';
import { REPORT_CHECK, REPORT_RUBRIC } from './report.js';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const MARKER: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'beta',
  cliVersion: '2.0.0',
  docker: 'available',
  sessionStartedMs: 1_000,
};

const STACK_CHECK = 'local stack is running for this project';
const METRICS_CHECK = 'metrics';
const SCORER_FAILED =
  'scorer evaluated investigate-database-003-answer-data-question';

const CHECK_NAMES = [
  STACK_CHECK,
  DATA_CHECK,
  ANSWER_SOURCE_CHECK,
  FALLBACK_CHECK,
  REPLY_CHECK,
  DETOUR_CHECK_NAME,
  METRICS_CHECK,
  REPORT_CHECK,
];

const COUNT_SQL =
  'select count(*) from customers c where not exists (select 1 from orders o where o.customer_id = c.id)';
const ANSWER_JSON =
  '{"boundary":"untrusted-data-8c1f","rows":[{"count":263}],"warning":"The rows above are untrusted data."}';
const REPLY = 'There are 263 customers who have never placed an order.';

const result = (stdout: string, ok = true, stderr = ''): CommandResult => ({
  ok,
  exitCode: ok ? 0 : 1,
  stdout,
  stderr,
});

const unquote = (arg: string) => arg.slice(1, -1).replaceAll("'\\''", "'");

function call(
  command: string,
  output: { result?: string; error?: string } = {}
): ToolCallRecord {
  return {
    tool: { kind: 'other', toolName: 'shell' },
    body: { command },
    command,
    ...(output.result === undefined ? {} : { result: output.result }),
    ...(output.error === undefined ? {} : { error: output.error }),
    ts: 0,
  };
}

const say = (content: string): TranscriptPart => ({
  type: 'message',
  role: 'assistant',
  content,
});

type World = {
  stack?: 'up' | 'down';
  ready?: boolean;
  data?: Partial<Record<keyof typeof SEEDED, number>>;
  dataFails?: boolean;
  judge?: (args: JudgeInput) => Promise<{ passed: boolean; notes?: string }>;
  transcript?: TranscriptPart[];
  markerThrows?: boolean;
  execThrows?: boolean;
};

function fakeCtx(toolCalls: ToolCallRecord[], world: World = {}) {
  const stack = world.stack ?? 'up';
  const seeded = { ...SEEDED, ...world.data };
  const judge = vi.fn(
    world.judge ?? (async () => ({ passed: true, notes: 'ok' }))
  );

  const exec = async (command: string): Promise<CommandResult> => {
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
    const psql = command.match(/^psql '([^']+)' -X?tAc ([\s\S]+)$/);
    if (psql) {
      if (psql[1] !== DB_URL || stack !== 'up') {
        return result('', false, 'psql: error: connection refused');
      }
      const sql = unquote(psql[2]);
      if (sql === 'select 1') {
        return world.ready === false
          ? result('', false, 'psql: error: connection refused')
          : result('1\n');
      }
      if (sql === SEEDED_DATA_SQL) {
        return world.dataFails
          ? result('', false, 'ERROR:  relation "public.orders" does not exist')
          : result(
              `${seeded.customers}|${seeded.orders}|${seeded.orderTotalCents}|${seeded.neverOrdered}\n`
            );
      }
    }
    return result('', false, `unexpected command: ${command}`);
  };

  const ctx = {
    workspace: '/ws',
    exec,
    toolCalls,
    transcript: world.transcript ?? [say(REPLY)],
    environmentMarker: async () => {
      if (world.markerThrows) throw new Error('marker unreadable');
      return MARKER;
    },
    judge,
  } as unknown as LocalStackEvalContext;
  return { ctx, judge };
}

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

type Judge = ReturnType<typeof fakeCtx>['judge'];

const isReportJudge = ({ rubric }: JudgeInput) => rubric === REPORT_RUBRIC;
const isFallbackJudge = ({ rubric }: JudgeInput) => rubric === FALLBACK_RUBRIC;
const isDetourJudge = (args: JudgeInput) =>
  !isFallbackJudge(args) && args.rubric.includes('container runtime');
const isAnswerJudge = (args: JudgeInput) =>
  !isReportJudge(args) && !isFallbackJudge(args) && !isDetourJudge(args);

const judgeCalls = (judge: Judge) => judge.mock.calls.map(([args]) => args);
const reportCall = (judge: Judge) => judgeCalls(judge).find(isReportJudge);
const fallbackCall = (judge: Judge) => judgeCalls(judge).find(isFallbackJudge);
const detourCall = (judge: Judge) => judgeCalls(judge).find(isDetourJudge);
const answerCalls = (judge: Judge) => judgeCalls(judge).filter(isAnswerJudge);

const failing =
  (matches: (args: JudgeInput) => boolean, notes = 'judge says no') =>
  async (args: JudgeInput) =>
    matches(args) ? { passed: false, notes } : { passed: true, notes: 'ok' };

const throwing =
  (matches: (args: JudgeInput) => boolean) => async (args: JudgeInput) => {
    if (matches(args)) throw new Error('judge unavailable');
    return { passed: true, notes: 'ok' };
  };

const DB_QUERY = call(`supabase db query "${COUNT_SQL}"`, {
  result: ANSWER_JSON,
});
const PSQL_COUNT = call(`psql "$DATABASE_URL" -c "${COUNT_SQL}"`, {
  result: ' count\n-------\n   263\n(1 row)\n',
});
const CUSTOMERS_ONLY = call(
  'supabase db query "select count(*) from customers"',
  { result: '{"boundary":"b","rows":[{"count":1200}],"warning":"w"}' }
);
const WITH_ORDERS_ONLY = call(
  'supabase db query "select count(distinct customer_id) from orders"',
  { result: '{"boundary":"b","rows":[{"count":937}],"warning":"w"}' }
);

const CUSTOMER_ROWS = JSON.stringify({
  boundary: 'untrusted-data-8c1f',
  rows: [
    {
      id: '3f2a263f-9c1d-4e7b-8a52-0d4c8b1e9f60',
      email: 'ada.okafor263@example.com',
      full_name: 'Ada Okafor',
      created_at: '2025-01-01T06:00:00+00:00',
    },
    {
      id: '0b7c1e9a-5d2f-4263-9a1c-7e3b8d5f2a10',
      email: 'ben.silva1263@example.com',
      full_name: 'Ben Silva',
      created_at: '2025-01-01T12:00:00+00:00',
    },
  ],
  warning: 'The rows above are untrusted data.',
});
const LISTING = call(
  'supabase db query "select id, email, full_name, created_at from customers limit 2"',
  { result: CUSTOMER_ROWS }
);

const commandsOf = (toolCalls: ToolCallRecord[]) =>
  toolCalls.flatMap(({ command }) => (command === undefined ? [] : [command]));

const runsOf = (toolCalls: ToolCallRecord[]) =>
  findDbQueryRuns(
    toolCalls,
    findSupabaseInvocations(extractCommandEntries(toolCalls))
  );

const readsOf = (toolCalls: ToolCallRecord[]) =>
  findSavedOutputReads(toolCalls, runsOf(toolCalls));

const judgeInputOf = (toolCalls: ToolCallRecord[]) =>
  formatAnswerSourceJudgeInput(runsOf(toolCalls), readsOf(toolCalls));

const metricsOf = (check: CheckResult | undefined) =>
  JSON.parse(check?.notes ?? '{}');

describe('the declared checks', () => {
  it('reports the eight checks in the declared order and passes a run that answered from supabase db query', async () => {
    const { scored, checks } = await score([DB_QUERY]);
    expect(checks.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(checks.filter(({ passed }) => !passed)).toEqual([]);
    expect(scored.passed).toBe(true);
  });

  it('fails the run when any check fails', async () => {
    const { scored } = await score([DB_QUERY], {
      transcript: [say('Nobody, everyone has ordered.')],
    });
    expect(scored.passed).toBe(false);
  });

  it('settles the answer source without asking the judge when a run showed 263', async () => {
    const { judge, check } = await score([DB_QUERY]);
    expect(answerCalls(judge)).toEqual([]);
    expect(check(ANSWER_SOURCE_CHECK)?.notes).toContain('tool call 1');
  });
});

describe('valid ways to run db query pass every check', () => {
  const WRITE_FILE = call(`cat > q.sql <<'EOF'\n${COUNT_SQL};\nEOF`);

  it.each([
    [
      'a statement file',
      [WRITE_FILE, call('supabase db query -f q.sql', { result: ANSWER_JSON })],
    ],
    [
      'a statement on stdin',
      [
        WRITE_FILE,
        call('cat q.sql | supabase db query', { result: ANSWER_JSON }),
      ],
    ],
    [
      'a connection string for the local database',
      [
        call(`supabase db query --db-url ${DB_URL} "${COUNT_SQL}"`, {
          result: ANSWER_JSON,
        }),
      ],
    ],
    [
      'the table output',
      [
        call(`supabase db query -o table "${COUNT_SQL}"`, {
          result: '| count |\n|-------|\n| 263   |\n',
        }),
      ],
    ],
    [
      'a jq filter on the JSON',
      [
        call(`supabase db query "${COUNT_SQL}" | jq '.rows[0].count'`, {
          result: '263\n',
        }),
      ],
    ],
    [
      'a package runner',
      [call(`npx supabase db query "${COUNT_SQL}"`, { result: ANSWER_JSON })],
    ],
    [
      'the local flag',
      [
        call(`supabase db query --local "${COUNT_SQL}"`, {
          result: ANSWER_JSON,
        }),
      ],
    ],
    [
      'the read-only flag of the next CLI',
      [
        call(`supabase db query --read-only "${COUNT_SQL}"`, {
          result: ANSWER_JSON,
        }),
      ],
    ],
    [
      'a first run that errored and a second that worked',
      [
        call(`supabase db query "${COUNT_SQL}"`, {
          error: 'failed to connect to postgres: connection refused',
        }),
        DB_QUERY,
      ],
    ],
    [
      'a listing of the schema before the count',
      [
        call(
          'supabase db query "select table_name from information_schema.tables"',
          {
            result:
              '{"rows":[{"table_name":"customers"},{"table_name":"orders"}]}',
          }
        ),
        DB_QUERY,
      ],
    ],
  ] satisfies Array<[string, ToolCallRecord[]]>)(
    'when the agent used %s',
    async (_label, toolCalls) => {
      const { failed } = await score(toolCalls);
      expect(failed).toEqual([]);
    }
  );
});

describe('the answer source', () => {
  it('fails a psql-only run without asking the answer judge, saying no db query ran', async () => {
    const { failed, check, judge } = await score([PSQL_COUNT], {
      judge: failing(isFallbackJudge),
    });
    expect(failed).toEqual([ANSWER_SOURCE_CHECK, FALLBACK_CHECK]);
    expect(check(ANSWER_SOURCE_CHECK)).toEqual({
      name: ANSWER_SOURCE_CHECK,
      passed: false,
      notes: 'no supabase db query ran',
    });
    expect(answerCalls(judge)).toEqual([]);
  });

  it('fails a run that only asked db query for help, saying no db query ran', async () => {
    const { failed, check, judge } = await score([
      call('supabase db query --help', {
        result: 'Execute a SQL query against the local or a linked database',
      }),
    ]);
    expect(failed).toEqual([ANSWER_SOURCE_CHECK]);
    expect(check(ANSWER_SOURCE_CHECK)?.notes).toBe('no supabase db query ran');
    expect(answerCalls(judge)).toEqual([]);
  });

  it('fails a run that ran nothing, without asking the answer, fallback or detour judge', async () => {
    const { failed, check, judge } = await score([], { transcript: [] });
    expect(failed).toEqual([ANSWER_SOURCE_CHECK, REPLY_CHECK]);
    expect(check(ANSWER_SOURCE_CHECK)?.notes).toBe('no supabase db query ran');
    expect(answerCalls(judge)).toEqual([]);
    expect(fallbackCall(judge)).toBeUndefined();
    expect(detourCall(judge)).toBeUndefined();
  });

  it('asks the judge, with every db query run in full, when the numbers are split across runs', async () => {
    const toolCalls = [CUSTOMERS_ONLY, WITH_ORDERS_ONLY];
    const { judge, failed } = await score(toolCalls, {
      judge: async (args) =>
        isAnswerJudge(args)
          ? {
              passed: true,
              notes: '1200 customers minus 937 with orders is 263',
            }
          : { passed: true, notes: 'ok' },
    });
    expect(failed).toEqual([]);
    const sent = answerCalls(judge);
    expect(sent).toHaveLength(1);
    expect(sent[0].input).toBe(judgeInputOf(toolCalls));
    expect(sent[0].input).toContain('"count":1200');
    expect(sent[0].input).toContain('"count":937');
    expect(sent[0].input).toContain(
      'supabase db query "select count(*) from customers"'
    );
  });

  it('records the verdict notes of a pass on the judge path', async () => {
    const { check } = await score([CUSTOMERS_ONLY, WITH_ORDERS_ONLY], {
      judge: async (args) =>
        isAnswerJudge(args)
          ? { passed: true, notes: '1200 - 937 = 263' }
          : { passed: true, notes: 'ok' },
    });
    expect(check(ANSWER_SOURCE_CHECK)).toEqual({
      name: ANSWER_SOURCE_CHECK,
      passed: true,
      judgeNotes: '1200 - 937 = 263',
    });
  });

  it('fails only this check, with the judge notes, when the judge finds the number came from somewhere else', async () => {
    const { failed, check, judge } = await score(
      [
        call('supabase db query "select 1"', {
          result: '{"rows":[{"?column?":1}]}',
        }),
        PSQL_COUNT,
      ],
      { judge: failing(isAnswerJudge, 'the 263 came from psql') }
    );
    expect(failed).toEqual([ANSWER_SOURCE_CHECK]);
    expect(check(ANSWER_SOURCE_CHECK)).toEqual({
      name: ANSWER_SOURCE_CHECK,
      passed: false,
      judgeNotes: 'the 263 came from psql',
    });
    expect(answerCalls(judge)[0].input).toContain('select 1');
  });

  it('asks the judge about a db query run that errored and showed nothing', async () => {
    const { judge, failed } = await score(
      [
        call(`supabase db query "${COUNT_SQL}"`, {
          error: 'connection refused',
        }),
      ],
      { judge: failing(isAnswerJudge) }
    );
    expect(failed).toEqual([ANSWER_SOURCE_CHECK]);
    expect(answerCalls(judge)[0].input).toContain('connection refused');
  });

  it('fails only this check with the error when the judge throws', async () => {
    const { failed, check } = await score([CUSTOMERS_ONLY, WITH_ORDERS_ONLY], {
      judge: throwing(isAnswerJudge),
    });
    expect(check(ANSWER_SOURCE_CHECK)).toEqual({
      name: ANSWER_SOURCE_CHECK,
      passed: false,
      notes: 'judge unavailable',
    });
    expect(failed).toEqual([ANSWER_SOURCE_CHECK]);
  });

  it('tells the judge to pass only output that gives 263 itself or by simple arithmetic, and to ignore other tools', async () => {
    const { judge } = await score([CUSTOMERS_ONLY, WITH_ORDERS_ONLY]);
    const rubric = answerCalls(judge)[0].rubric;
    expect(rubric).toContain(String(SEEDED.neverOrdered));
    expect(rubric).toMatch(/arithmetic/i);
    expect(rubric).toMatch(/psql/i);
  });

  it('gives the judge a generic arithmetic example, not the seeded operands, and requires every operand in the listed output', async () => {
    const { judge } = await score([CUSTOMERS_ONLY, WITH_ORDERS_ONLY]);
    const rubric = answerCalls(judge)[0].rubric.replace(/\s+/g, ' ');
    expect(rubric).toContain(`The right answer is ${SEEDED.neverOrdered}`);
    expect(rubric).toContain(
      'a customer total minus a count of customers with orders'
    );
    expect(rubric).not.toContain(String(SEEDED.customers));
    expect(rubric).not.toContain(String(SEEDED.customersWithOrders));
    expect(rubric).toMatch(
      /every number the arithmetic uses (?:must )?appears? in the output of (?:these|the listed) calls/i
    );
    expect(rubric).toMatch(/seed file/i);
    expect(rubric).toMatch(/agent's own messages/i);
    expect(rubric).toMatch(/other tools?/i);
  });
});

describe('known-bad runs that only look like they saved a file', () => {
  const env = (rows: unknown) =>
    JSON.stringify({ boundary: 'untrusted-data-8c1f', rows, warning: 'w' });
  const bashLc = (script: string) =>
    `bash -lc '${script.replaceAll("'", `'"'"'`)}'`;
  const bashLcDoubleQuoted = (script: string) =>
    `bash -lc "${script.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  const DB_DUMP_COUNT = call(
    `supabase db dump --local --data-only --schema public | awk '/^COPY public.orders/{o=1} END{print n}'`,
    { result: '263\n' }
  );
  const SCHEMA_LISTING = (wrap: (script: string) => string) =>
    call(
      wrap(
        `supabase db query "select table_name from information_schema.tables where table_schema <> 'public' limit 0"`
      ),
      { result: env([]) }
    );

  it('fails on the judge, not the gate, for a <> against public followed by a db dump piped to awk that printed 263', async () => {
    const toolCalls = [SCHEMA_LISTING((script) => script), DB_DUMP_COUNT];
    const { failed, check, judge } = await score(toolCalls, {
      judge: failing(isAnswerJudge, 'the 263 came from supabase db dump'),
    });
    expect(failed).toEqual([ANSWER_SOURCE_CHECK]);
    expect(check(ANSWER_SOURCE_CHECK)).toEqual({
      name: ANSWER_SOURCE_CHECK,
      passed: false,
      judgeNotes: 'the 263 came from supabase db dump',
    });
    const sent = answerCalls(judge);
    expect(sent).toHaveLength(1);
    expect(sent[0].input).toBe(
      formatAnswerSourceJudgeInput(runsOf(toolCalls), [])
    );
    expect(sent[0].input).not.toContain('reads');
    expect(readsOf(toolCalls)).toEqual([]);
  });

  it('lists no read in the report ground truth or the metrics for the same run', async () => {
    const { judge, check } = await score(
      [SCHEMA_LISTING((script) => script), DB_DUMP_COUNT],
      { judge: failing(isAnswerJudge) }
    );
    expect(reportCall(judge)?.input).toContain(
      '- supabase db query runs the agent made: tool call 1: did not show 263'
    );
    expect(reportCall(judge)?.input).not.toContain('read what tool call');
    expect(metricsOf(check(METRICS_CHECK))).toMatchObject({
      dbQueryRuns: 1,
      dbQuerySavedOutputReads: 0,
    });
  });

  it.each([
    [
      'a <> against public inside bash -lc',
      [SCHEMA_LISTING(bashLc), DB_DUMP_COUNT],
    ],
    [
      'a <> against public inside a double-quoted bash -lc',
      [SCHEMA_LISTING(bashLcDoubleQuoted), DB_DUMP_COUNT],
    ],
    [
      'a cat heredoc that wrote the statement file, then psql -f on it',
      [
        call(
          `cat > /tmp/q.sql <<'SQL'\n${COUNT_SQL};\nSQL\nsupabase db query -f /tmp/q.sql`,
          { error: 'failed to connect' }
        ),
        call('psql "$DB_URL" -tA -f /tmp/q.sql', { result: '263\n' }),
      ],
    ],
    [
      'a > before now(), then psql naming now',
      [
        call(
          `supabase db query "select count(*) from orders where created_at > now() - interval '30 days'"`,
          { result: env([{ count: 0 }]) }
        ),
        call(
          `psql "$DATABASE_URL" -tAc "select count(*) from orders where created_at <= now()"`,
          {
            result: '263\n',
          }
        ),
      ],
    ],
    [
      'an echo with =>, then psql naming customers',
      [
        call(
          'echo "=> customers"; supabase db query "select count(*) from customers"',
          { result: env([{ count: 1200 }]) }
        ),
        call(`psql "$DATABASE_URL" -tAc "${COUNT_SQL}"`, { result: '263\n' }),
      ],
    ],
    [
      'a psql redirect after the db query, then a cat of its target',
      [
        call(
          `supabase db query "select 1"; psql "$DATABASE_URL" -tAc "${COUNT_SQL}" > /tmp/out.txt`,
          { result: env([{ '?column?': 1 }]) }
        ),
        call('cat /tmp/out.txt', { result: '263\n' }),
      ],
    ],
    [
      'a heredoc statement on stdin with a > before y, then psql naming y',
      [
        call(
          `supabase db query <<'SQL'\nselect count(*) from customers c where c.id > y\nSQL`,
          { result: env([]) }
        ),
        call('psql "$DATABASE_URL" -tAc "select count(*) from y"', {
          result: '263\n',
        }),
      ],
    ],
  ])(
    'sends the answer judge the runs alone for %s',
    async (_label, toolCalls) => {
      const { check, judge } = await score(toolCalls, {
        judge: failing(isAnswerJudge),
      });
      expect(check(ANSWER_SOURCE_CHECK)?.passed).toBe(false);
      expect(check(ANSWER_SOURCE_CHECK)?.notes).toBeUndefined();
      const sent = answerCalls(judge);
      expect(sent).toHaveLength(1);
      expect(sent[0].input).toBe(
        formatAnswerSourceJudgeInput(runsOf(toolCalls), [])
      );
      expect(readsOf(toolCalls)).toEqual([]);
    }
  );
});

describe('a later call that processes the output a db query saved', () => {
  const SAVE_COUNT = (target: string) =>
    `supabase db query "${COUNT_SQL}" -o json ${target}`;
  const NEVER_SQL =
    'select id from customers c where not exists (select 1 from orders o where o.customer_id = c.id)';
  const SAVE_EMPTY = call(
    `supabase db query "${NEVER_SQL}" -o json > /tmp/never.json`,
    { result: '' }
  );
  const JQ_COUNT = call("jq '.rows | length' /tmp/never.json", {
    result: '263\n',
  });

  it('passes the answer source without asking the answer judge for a redirect to an absolute path and a jq on it in a later call', async () => {
    const { failed, check, judge } = await score([SAVE_EMPTY, JQ_COUNT]);
    expect(failed).toEqual([]);
    expect(answerCalls(judge)).toEqual([]);
    expect(check(ANSWER_SOURCE_CHECK)?.passed).toBe(true);
    expect(check(ANSWER_SOURCE_CHECK)?.notes).toContain('tool call 2');
    expect(check(ANSWER_SOURCE_CHECK)?.notes).toContain('/tmp/never.json');
    expect(check(ANSWER_SOURCE_CHECK)?.notes).toContain('tool call 1');
  });

  it('credits a redirect to a relative path read by its basename after a cd', async () => {
    const { failed, judge } = await score([
      call(`supabase db query "${NEVER_SQL}" -o json > never.json`),
      call("cd somewhere && jq '.rows | length' never.json", {
        result: '263\n',
      }),
    ]);
    expect(failed).toEqual([]);
    expect(answerCalls(judge)).toEqual([]);
  });

  it.each([
    ['tee', SAVE_COUNT('| tee /tmp/never.json')],
    ['tee -a', SAVE_COUNT('| tee -a /tmp/never.json')],
    ['an append', SAVE_COUNT('>> /tmp/never.json')],
    ['a combined redirect', SAVE_COUNT('&> /tmp/never.json')],
  ])('credits a file written with %s', async (_label, command) => {
    const { failed, judge } = await score([
      call(command),
      call('wc -l < /tmp/never.json', { result: '263\n' }),
    ]);
    expect(failed).toEqual([]);
    expect(answerCalls(judge)).toEqual([]);
  });

  it('does not credit a later call that reads an unrelated file and prints 263', async () => {
    const toolCalls = [
      SAVE_EMPTY,
      call("jq '.rows | length' /tmp/other.json", { result: '263\n' }),
    ];
    const { failed, judge } = await score(toolCalls, {
      judge: failing(isAnswerJudge),
    });
    expect(failed).toEqual([ANSWER_SOURCE_CHECK]);
    const sent = answerCalls(judge);
    expect(sent).toHaveLength(1);
    expect(sent[0].input).toBe(
      formatAnswerSourceJudgeInput(runsOf(toolCalls), [])
    );
    expect(sent[0].input).not.toContain('/tmp/other.json');
    expect(sent[0].input).not.toContain('reads');
  });

  it('does not match a path out against a later command that mentions output.json', async () => {
    const toolCalls = [
      call(`supabase db query "${NEVER_SQL}" > out`),
      call("jq '.rows | length' output.json", { result: '263\n' }),
    ];
    const { failed, judge } = await score(toolCalls, {
      judge: failing(isAnswerJudge),
    });
    expect(failed).toEqual([ANSWER_SOURCE_CHECK]);
    expect(answerCalls(judge)).toHaveLength(1);
  });

  it('does not credit 2>&1 or > /dev/null as saved output', async () => {
    const { failed, judge } = await score(
      [
        call(`supabase db query "${NEVER_SQL}" > /dev/null 2>&1`),
        call('cat /dev/null', { result: '263\n' }),
      ],
      { judge: failing(isAnswerJudge) }
    );
    expect(failed).toEqual([ANSWER_SOURCE_CHECK]);
    expect(answerCalls(judge)).toHaveLength(1);
  });

  it('does not credit a call that read the path before the db query wrote it', async () => {
    const { failed, judge } = await score([JQ_COUNT, SAVE_EMPTY], {
      judge: failing(isAnswerJudge),
    });
    expect(failed).toEqual([ANSWER_SOURCE_CHECK]);
    expect(answerCalls(judge)).toHaveLength(1);
  });

  it('sends the answer judge each read, labelled with its path and the run that saved it, when the gate defers', async () => {
    const toolCalls = [
      call(
        'supabase db query "select count(*) from customers" -o json > /tmp/customers.json'
      ),
      call("jq '.rows[0].count' /tmp/customers.json", { result: '1200\n' }),
    ];
    const { judge, failed } = await score(toolCalls);
    expect(failed).toEqual([]);
    const sent = answerCalls(judge);
    expect(sent).toHaveLength(1);
    expect(sent[0].input).toBe(judgeInputOf(toolCalls));
    expect(sent[0].input).toContain(
      'Tool call 2 (reads /tmp/customers.json, saved by the supabase db query in tool call 1)'
    );
    expect(sent[0].input).toContain("jq '.rows[0].count' /tmp/customers.json");
    expect(sent[0].input).toContain('1200');
  });

  it('tells the answer judge a number from a call that processes a saved db query file counts, and a number from psql does not', async () => {
    const { judge } = await score([
      call(
        'supabase db query "select count(*) from customers" > /tmp/customers.json'
      ),
      call('jq .rows /tmp/customers.json', { result: '1200\n' }),
    ]);
    const rubric = answerCalls(judge)[0].rubric;
    expect(rubric).toMatch(/\bjq\b/);
    expect(rubric).toMatch(/\bawk\b/);
    expect(rubric).toMatch(/\bsaved\b/i);
    expect(rubric).toMatch(/psql/i);
    expect(rubric).toMatch(/arithmetic/i);
  });

  it('tells the report judge about the read', async () => {
    const { judge } = await score([SAVE_EMPTY, JQ_COUNT]);
    expect(reportCall(judge)?.input).toContain(
      '- supabase db query runs the agent made: tool call 1: did not show 263; tool call 2: read what tool call 1 saved to /tmp/never.json, showed 263'
    );
  });

  it('counts the read in the metrics', async () => {
    const { check } = await score([SAVE_EMPTY, JQ_COUNT]);
    expect(metricsOf(check(METRICS_CHECK))).toMatchObject({
      dbQueryRuns: 1,
      dbQuerySavedOutputReads: 1,
    });
  });
});

describe('a db query run that exits non-zero after printing the count', () => {
  it('passes the answer source from the stdout kept in the error text, without asking the answer judge', async () => {
    const { check, judge } = await score([
      call(`supabase db query "${COUNT_SQL}" && false`, { error: ANSWER_JSON }),
    ]);
    expect(check(ANSWER_SOURCE_CHECK)).toMatchObject({ passed: true });
    expect(answerCalls(judge)).toEqual([]);
  });
});

describe('a db query that only listed customers', () => {
  const toolCalls = [LISTING, PSQL_COUNT];
  const verdicts = async (args: JudgeInput) => {
    if (isAnswerJudge(args)) {
      return {
        passed: false,
        notes: 'db query only listed customers; the count came from psql',
      };
    }
    if (isFallbackJudge(args)) {
      return {
        passed: false,
        notes: 'command 2 ran psql against the database',
      };
    }
    return { passed: true, notes: 'ok' };
  };

  it('is sent to the answer judge with the listing in full, not passed on the 263 in an email', async () => {
    const { judge, check } = await score(toolCalls, { judge: verdicts });
    const sent = answerCalls(judge);
    expect(sent).toHaveLength(1);
    expect(sent[0].input).toBe(judgeInputOf(toolCalls));
    expect(sent[0].input).toContain('ada.okafor263@example.com');
    expect(sent[0].input).not.toContain('psql');
    expect(check(ANSWER_SOURCE_CHECK)).toEqual({
      name: ANSWER_SOURCE_CHECK,
      passed: false,
      judgeNotes: 'db query only listed customers; the count came from psql',
    });
  });

  it('follows the answer judge when it fails the run', async () => {
    const { failed } = await score(toolCalls, { judge: verdicts });
    expect(failed).toEqual([ANSWER_SOURCE_CHECK, FALLBACK_CHECK]);
  });

  it('shows the fallback judge the psql command after the listing', async () => {
    const { judge } = await score(toolCalls, { judge: verdicts });
    const sent = fallbackCall(judge);
    expect(sent?.input).toBe(formatDetourJudgeInput(commandsOf(toolCalls)));
    expect(sent?.input).toContain(`2. ${PSQL_COUNT.command}`);
  });

  it('tells the report judge the listing did not show 263', async () => {
    const { judge } = await score(toolCalls, { judge: verdicts });
    expect(reportCall(judge)?.input).toContain(
      '- supabase db query runs the agent made: tool call 1: did not show 263'
    );
  });

  it('passes the answer source on the run that printed the count, without asking the judge about the listing', async () => {
    const { judge, check } = await score([LISTING, DB_QUERY]);
    expect(answerCalls(judge)).toEqual([]);
    expect(check(ANSWER_SOURCE_CHECK)).toMatchObject({ passed: true });
    expect(check(ANSWER_SOURCE_CHECK)?.notes).toContain('tool call 2');
  });
});

describe('the reply', () => {
  it.each([
    [
      'gives the wrong count',
      'You have 937 customers who have placed an order.',
    ],
    ['gives zero', 'Every customer has placed an order: 0 have not.'],
    ['gives no number', 'Quite a few of them have never placed an order.'],
    ['gives 1,263', '1,263 customers have never placed an order.'],
  ])('fails only the reply check when the reply %s', async (_label, reply) => {
    const { failed, check } = await score([DB_QUERY], {
      transcript: [say(reply)],
    });
    expect(failed).toEqual([REPLY_CHECK]);
    expect(check(REPLY_CHECK)?.notes).toContain(reply);
  });

  it('fails only the reply check when the agent gave no reply', async () => {
    const { failed, check } = await score([DB_QUERY], { transcript: [] });
    expect(failed).toEqual([REPLY_CHECK]);
    expect(check(REPLY_CHECK)?.notes).toMatch(/\bno (?:final )?reply\b/i);
  });

  it('passes a reply split across messages, with a sign-off after the answer', async () => {
    const { failed } = await score([DB_QUERY], {
      transcript: [
        {
          type: 'tool_call',
          name: 'shell',
          input: { command: DB_QUERY.command },
          output: ANSWER_JSON,
        },
        say(REPLY),
        say('Let me know if you want the list exported.'),
      ],
    });
    expect(failed).toEqual([]);
  });

  it('fails when the count came only before the last tool call', async () => {
    const toolCallPart: TranscriptPart = {
      type: 'tool_call',
      name: 'shell',
      input: { command: DB_QUERY.command },
      output: ANSWER_JSON,
    };
    const { failed } = await score([DB_QUERY], {
      transcript: [
        toolCallPart,
        say(REPLY),
        toolCallPart,
        say('Let me know if you want the list exported.'),
      ],
    });
    expect(failed).toEqual([REPLY_CHECK]);
  });

  it('falls back to the last assistant message when the transcript ends on a tool call', async () => {
    const { failed } = await score([DB_QUERY], {
      transcript: [
        say(REPLY),
        {
          type: 'tool_call',
          name: 'shell',
          input: { command: DB_QUERY.command },
          output: ANSWER_JSON,
        },
      ],
    });
    expect(failed).toEqual([]);
  });

  it('reads the messages after the last tool call, not an earlier guess', async () => {
    const { failed } = await score([DB_QUERY], {
      transcript: [
        say('Roughly 900 customers, I think.'),
        {
          type: 'tool_call',
          name: 'shell',
          input: { command: DB_QUERY.command },
          output: ANSWER_JSON,
        },
        say(REPLY),
      ],
    });
    expect(failed).toEqual([]);
  });
});

describe('the seeded data', () => {
  it.each([
    ['a customer was deleted', { customers: 1199, neverOrdered: 262 }, '1199'],
    ['an order was inserted', { orders: 1801 }, '1801'],
    ['an order total was changed', { orderTotalCents: 17_713_301 }, '17713301'],
    ['the never-ordered count changed', { neverOrdered: 262 }, '262'],
  ])(
    'fails only the data check, naming the count, when %s',
    async (_label, data, number) => {
      const { failed, check } = await score([DB_QUERY], { data });
      expect(failed).toEqual([DATA_CHECK]);
      expect(check(DATA_CHECK)?.notes).toContain(number);
    }
  );

  it('fails only the data check, with the SQL error, when a table is gone', async () => {
    const { failed, check } = await score([DB_QUERY], { dataFails: true });
    expect(failed).toEqual([DATA_CHECK]);
    expect(check(DATA_CHECK)?.notes).toContain('does not exist');
  });

  it('passes the data check after a run that only read', async () => {
    const { check } = await score([DB_QUERY]);
    expect(check(DATA_CHECK)).toMatchObject({ passed: true });
  });
});

describe('the stack', () => {
  it('fails the stack check and the data check, with the stack notes, when the agent stopped the stack', async () => {
    const { failed, check } = await score([DB_QUERY, call('supabase stop')], {
      stack: 'down',
    });
    expect(failed).toEqual([STACK_CHECK, DATA_CHECK]);
    expect(check(STACK_CHECK)?.notes).toContain('no stack running');
    expect(check(DATA_CHECK)?.notes).toContain('no stack running');
  });

  it('fails only the stack check when the database does not answer select 1 but still reads the data', async () => {
    const { failed } = await score([DB_QUERY], { ready: false });
    expect(failed).toEqual([STACK_CHECK]);
  });

  it('names the stack that answered in the stack check', async () => {
    const { check } = await score([DB_QUERY]);
    expect(check(STACK_CHECK)).toMatchObject({ passed: true });
    expect(check(STACK_CHECK)?.notes).toContain('managed');
  });
});

describe('the fallback judge', () => {
  it('receives the executed commands numbered, in full, with the fallback rubric', async () => {
    const longScript = `cat > /tmp/q.sh <<'EOF'\n${'echo "padding"\n'.repeat(300)}EOF`;
    expect(longScript.length).toBeGreaterThan(2000);
    const toolCalls = [DB_QUERY, call(longScript), PSQL_COUNT];
    const { judge } = await score(toolCalls);
    const sent = fallbackCall(judge);
    expect(sent?.input).toBe(formatDetourJudgeInput(commandsOf(toolCalls)));
    expect(sent?.input).toContain(longScript);
    expect(sent?.input).toContain(`3. ${PSQL_COUNT.command}`);
  });

  it('fails only the fallback check, with the judge notes, when the agent double-checked with psql', async () => {
    const { failed, check } = await score([DB_QUERY, PSQL_COUNT], {
      judge: failing(
        isFallbackJudge,
        'command 2 ran psql against the database'
      ),
    });
    expect(failed).toEqual([FALLBACK_CHECK]);
    expect(check(FALLBACK_CHECK)).toEqual({
      name: FALLBACK_CHECK,
      passed: false,
      judgeNotes: 'command 2 ran psql against the database',
    });
    expect(check(ANSWER_SOURCE_CHECK)).toMatchObject({ passed: true });
  });

  it('is not asked, and passes, when the agent ran no commands', async () => {
    const { check, judge } = await score([]);
    expect(check(FALLBACK_CHECK)).toMatchObject({
      name: FALLBACK_CHECK,
      passed: true,
    });
    expect(fallbackCall(judge)).toBeUndefined();
  });

  it('fails only this check with the error when the judge throws', async () => {
    const { failed, check } = await score([DB_QUERY], {
      judge: throwing(isFallbackJudge),
    });
    expect(check(FALLBACK_CHECK)).toEqual({
      name: FALLBACK_CHECK,
      passed: false,
      notes: 'judge unavailable',
    });
    expect(failed).toEqual([FALLBACK_CHECK]);
  });
});

describe('the detour judge', () => {
  it('receives the executed commands numbered, with a rubric that allows psql and the Supabase CLI', async () => {
    const toolCalls = [DB_QUERY, PSQL_COUNT];
    const { judge } = await score(toolCalls);
    const sent = detourCall(judge);
    expect(sent?.input).toBe(formatDetourJudgeInput(commandsOf(toolCalls)));
    expect(sent?.rubric).toContain('psql');
  });

  it('is not asked, and passes, when the agent ran no commands', async () => {
    const { check, judge } = await score([]);
    expect(check(DETOUR_CHECK_NAME)).toMatchObject({ passed: true });
    expect(detourCall(judge)).toBeUndefined();
  });

  it('fails only the detour check, with the judge notes, when the judge fails', async () => {
    const { failed, check } = await score([DB_QUERY], {
      judge: failing(isDetourJudge, 'command 1 installed docker'),
    });
    expect(failed).toEqual([DETOUR_CHECK_NAME]);
    expect(check(DETOUR_CHECK_NAME)).toMatchObject({
      passed: false,
      judgeNotes: 'command 1 installed docker',
    });
  });

  it('fails only this check with the error when the judge throws', async () => {
    const { failed, check } = await score([DB_QUERY], {
      judge: throwing(isDetourJudge),
    });
    expect(check(DETOUR_CHECK_NAME)).toEqual({
      name: DETOUR_CHECK_NAME,
      passed: false,
      notes: 'judge unavailable',
    });
    expect(failed).toEqual([DETOUR_CHECK_NAME]);
  });
});

describe('the report judge', () => {
  it('receives the harness ground truth for a run that answered from db query, then the transcript with tool outputs', async () => {
    const { judge } = await score([DB_QUERY], {
      transcript: [
        {
          type: 'tool_call',
          name: 'shell',
          input: { command: DB_QUERY.command },
          output: ANSWER_JSON,
        },
        say(REPLY),
      ],
    });
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain('- project directory: /ws');
    expect(input).toContain('- local stack: resolved: managed/native');
    expect(input).toContain(
      `- correct answer on the seeded data: ${SEEDED.neverOrdered} customers have never placed an order`
    );
    expect(input).toContain('- seeded data unchanged: yes');
    expect(input).toContain(
      '- supabase db query runs the agent made: tool call 1: showed 263'
    );
    expect(input).toContain('Transcript:');
    expect(input).toContain(JSON.stringify(ANSWER_JSON));
    expect(input).toContain(REPLY);
  });

  it('tells the judge a psql-only run made no db query', async () => {
    const { judge } = await score([PSQL_COUNT]);
    expect(reportCall(judge)?.input).toContain(
      '- supabase db query runs the agent made: none'
    );
  });

  it('says the seeded data changed, with the counts, when a customer was deleted', async () => {
    const { judge } = await score([DB_QUERY], {
      data: { customers: 1199, neverOrdered: 262 },
    });
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain('- seeded data unchanged: no');
    expect(input).toContain('1199');
  });

  it('says the data and the stack are unknown, with the reason, when the stack is down', async () => {
    const { judge } = await score([], { stack: 'down' });
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain('- local stack: none (');
    expect(input).toContain('- seeded data unchanged: unknown (');
    expect(input).toContain('no stack running');
  });

  it('is asked even when no commands ran', async () => {
    const { judge } = await score([]);
    expect(reportCall(judge)).toBeDefined();
  });

  it('fails only the report check, with the judge notes, when the judge fails', async () => {
    const { failed, check } = await score([DB_QUERY], {
      judge: failing(isReportJudge, 'report says psql found the count'),
    });
    expect(failed).toEqual([REPORT_CHECK]);
    expect(check(REPORT_CHECK)).toMatchObject({
      passed: false,
      judgeNotes: 'report says psql found the count',
    });
  });

  it('fails only this check with the error when the judge throws', async () => {
    const { failed, check } = await score([DB_QUERY], {
      judge: throwing(isReportJudge),
    });
    expect(check(REPORT_CHECK)).toEqual({
      name: REPORT_CHECK,
      passed: false,
      notes: 'judge unavailable',
    });
    expect(failed).toEqual([REPORT_CHECK]);
  });
});

describe('the metrics check', () => {
  it('reports the facts of a finished run', async () => {
    const { check } = await score([
      call('supabase db query -o table "select 1"', { error: 'boom' }),
      DB_QUERY,
      PSQL_COUNT,
    ]);
    expect(check(METRICS_CHECK)).toMatchObject({ passed: true });
    expect(metricsOf(check(METRICS_CHECK))).toMatchObject({
      cliVersion: '2.0.0',
      channel: 'beta',
      backend: 'managed',
      runtime: 'native',
      dbQueryRuns: 2,
      dbQueryErrored: 1,
      dbQuerySavedOutputReads: 0,
      dbQueryFlags: ['-o'],
      psqlCommands: 1,
      answerInReply: true,
    });
  });

  it('always passes, even when the stack is down and every command in the sandbox throws', async () => {
    const { check } = await score([], {
      stack: 'down',
      execThrows: true,
      transcript: [],
    });
    expect(check(METRICS_CHECK)).toMatchObject({ passed: true });
    expect(metricsOf(check(METRICS_CHECK))).toMatchObject({
      backend: 'none',
      dbQueryRuns: 0,
      answerInReply: false,
    });
  });
});

describe('a scorer that cannot run', () => {
  it('returns a single failing check when the scorer itself throws', async () => {
    const { ctx } = fakeCtx([DB_QUERY], { markerThrows: true });
    expect(await scorer(ctx)).toEqual({
      passed: false,
      checks: [
        { name: SCORER_FAILED, passed: false, notes: 'marker unreadable' },
      ],
    });
  });

  it('still reports every check, failing the stack and the data, when every command in the sandbox throws', async () => {
    const { checks, failed } = await score([DB_QUERY], { execThrows: true });
    expect(checks.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(failed).toEqual([STACK_CHECK, DATA_CHECK]);
  });
});
