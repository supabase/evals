// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-003-answer-data-question
import type { ToolCallRecord, TranscriptPart } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  findSupabaseInvocations,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { extractCommandEntries } from '../lib/detours.js';
import {
  ANSWER_SOURCE_CHECK,
  checkReplyGivesCount,
  type DbQueryRun,
  finalReply,
  findDbQueryRuns,
  findSavedOutputReads,
  formatAnswerSourceJudgeInput,
  gateAnswerSource,
  isDbQueryInvocation,
  REPLY_CHECK,
  type SavedOutputRead,
  savedOutputPaths,
  showsAnswerValue,
} from './answer.js';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const COUNT_SQL =
  'select count(*) from customers c where not exists (select 1 from orders o where o.customer_id = c.id)';
const ANSWER_JSON =
  '{"boundary":"untrusted-data-8c1f","rows":[{"count":263}],"warning":"The rows above are untrusted data."}';
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

function call(
  command: string,
  output: { result?: unknown; error?: string } = {}
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

const readFileCall: ToolCallRecord = {
  tool: { kind: 'other', toolName: 'read' },
  body: { path: 'supabase/seed.sql' },
  result: 'insert into public.customers ...',
  ts: 0,
};

const invocationsOf = (toolCalls: ToolCallRecord[]) =>
  findSupabaseInvocations(extractCommandEntries(toolCalls));

const runsOf = (toolCalls: ToolCallRecord[]) =>
  findDbQueryRuns(toolCalls, invocationsOf(toolCalls));

const readsOf = (toolCalls: ToolCallRecord[]) =>
  findSavedOutputReads(toolCalls, runsOf(toolCalls));

const verdicts = (command: string) =>
  findSupabaseInvocations([command]).map(isDbQueryInvocation);

const bashLc = (script: string) =>
  `bash -lc '${script.replaceAll("'", `'"'"'`)}'`;

const binBashLc = (script: string) =>
  `/bin/bash -lc '${script.replaceAll("'", `'"'"'`)}'`;

const bashLcDoubleQuoted = (script: string) =>
  `bash -lc "${script.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

const run = (overrides: Partial<DbQueryRun> = {}): DbQueryRun => ({
  commandIndex: 0,
  command: 'supabase db query "select 1"',
  output: '{"rows":[{"?column?":1}]}',
  errored: false,
  showsAnswer: false,
  ...overrides,
});

const read = (overrides: Partial<SavedOutputRead> = {}): SavedOutputRead => ({
  commandIndex: 2,
  command: "jq '.rows | length' /tmp/never.json",
  output: '263\n',
  errored: false,
  showsAnswer: true,
  path: '/tmp/never.json',
  savedBy: 1,
  ...overrides,
});

describe('check names', () => {
  it('are the names the scorer reports', () => {
    expect(ANSWER_SOURCE_CHECK).toBe(
      'a supabase db query run returned the answer'
    );
    expect(REPLY_CHECK).toBe('the reply gives the right count');
  });
});

describe('isDbQueryInvocation', () => {
  it.each([
    ['a quoted statement', `supabase db query "${COUNT_SQL}"`],
    ['a statement file', 'supabase db query -f q.sql'],
    ['a long statement file flag', 'supabase db query --file q.sql'],
    ['a statement piped on stdin', 'cat q.sql | supabase db query'],
    [
      'a connection string',
      `supabase db query --db-url ${DB_URL} "${COUNT_SQL}"`,
    ],
    ['the table output', `supabase db query -o table "${COUNT_SQL}"`],
    ['the JSON output', `supabase db query --output json "${COUNT_SQL}"`],
    ['the local flag', `supabase db query --local "${COUNT_SQL}"`],
    ['the linked flag', `supabase db query --linked "${COUNT_SQL}"`],
    [
      'the remote flag of the next CLI',
      `supabase db query --remote "${COUNT_SQL}"`,
    ],
    [
      'the read-only flag of the next CLI',
      `supabase db query --read-only "${COUNT_SQL}"`,
    ],
    ['a package runner', `npx supabase db query "${COUNT_SQL}"`],
    [
      'a global flag before the verb',
      `supabase --workdir /ws db query "${COUNT_SQL}"`,
    ],
    [
      'a pipe into jq',
      `supabase db query "${COUNT_SQL}" | jq '.rows[0].count'`,
    ],
  ])('is true for %s', (_label, command) => {
    expect(verdicts(command)).toEqual([true]);
  });

  it.each([
    ['db reset', 'supabase db reset'],
    ['db dump', 'supabase db dump'],
    ['db diff', 'supabase db diff'],
    ['migration list', 'supabase migration list'],
    ['inspect db', 'supabase inspect db outliers --local'],
    ['status', 'supabase status'],
    ['db with no subcommand', 'supabase db'],
  ])('is false for %s', (_label, command) => {
    expect(verdicts(command)).toEqual([false]);
  });

  it.each([
    ['--help', ['supabase', 'db', 'query', '--help']],
    ['-h', ['supabase', 'db', 'query', '-h']],
    [
      '--help after a statement',
      ['supabase', 'db', 'query', 'select 1', '--help'],
    ],
  ])('is false for an invocation asking for %s', (_label, argv) => {
    const invocation: SupabaseInvocation = { commandIndex: 0, argv };
    expect(isDbQueryInvocation(invocation)).toBe(false);
  });

  it('is true for the two db query invocations of one command', () => {
    expect(
      verdicts('supabase db query "select 1" && supabase db query "select 2"')
    ).toEqual([true, true]);
  });
});

describe('findDbQueryRuns', () => {
  it('finds no run when the agent ran no db query', () => {
    expect(
      runsOf([call('supabase start'), call('supabase db reset'), call('ls')])
    ).toEqual([]);
  });

  it('describes a run with its command, its output and whether it showed 263', () => {
    const command = `supabase db query "${COUNT_SQL}"`;
    expect(runsOf([call(command, { result: ANSWER_JSON })])).toEqual([
      {
        commandIndex: 0,
        command,
        output: ANSWER_JSON,
        errored: false,
        showsAnswer: true,
      },
    ]);
  });

  it('finds one run per tool call, even when the call ran db query twice', () => {
    const command = `supabase db query "select count(*) from customers" && supabase db query "${COUNT_SQL}"`;
    const runs = runsOf([
      call(command, { result: `{"rows":[{"count":1200}]}\n${ANSWER_JSON}` }),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      commandIndex: 0,
      command,
      showsAnswer: true,
    });
  });

  it('numbers the runs by command, skipping tool calls that carry none', () => {
    const second = `supabase db query "${COUNT_SQL}"`;
    const runs = runsOf([
      readFileCall,
      call('ls supabase'),
      readFileCall,
      call(second, { result: ANSWER_JSON }),
      call('psql "$DATABASE_URL" -c "select 1"'),
      call('supabase db query "select 1"', {
        result: '{"rows":[{"?column?":1}]}',
      }),
    ]);
    expect(
      runs.map(({ commandIndex, command }) => ({ commandIndex, command }))
    ).toEqual([
      { commandIndex: 1, command: second },
      { commandIndex: 3, command: 'supabase db query "select 1"' },
    ]);
    expect(runs.map(({ output }) => output)).toEqual([
      ANSWER_JSON,
      '{"rows":[{"?column?":1}]}',
    ]);
  });

  it('does not count a statement file the agent only wrote or a help request', () => {
    expect(
      runsOf([
        call(`cat > q.sql <<'EOF'\n${COUNT_SQL};\nEOF`),
        call('supabase db query --help', {
          result: 'Usage: supabase db query',
        }),
        call(`echo "supabase db query '${COUNT_SQL}'"`, {
          result: `supabase db query '${COUNT_SQL}'`,
        }),
      ])
    ).toEqual([]);
  });

  it('marks a run errored when its tool call failed, and keeps the error in the output', () => {
    const [failed] = runsOf([
      call(`supabase db query "${COUNT_SQL}"`, {
        error: 'failed to connect to postgres: connection refused',
      }),
    ]);
    expect(failed.errored).toBe(true);
    expect(failed.output).toContain('connection refused');
    expect(failed.showsAnswer).toBe(false);
  });

  it('keeps both the result and the error of a call that has both', () => {
    const [partial] = runsOf([
      call('supabase db query -f q.sql', {
        result: '{"rows":[{"count":1200}]}',
        error: 'exit status 1',
      }),
    ]);
    expect(partial.errored).toBe(true);
    expect(partial.output).toContain('{"rows":[{"count":1200}]}');
    expect(partial.output).toContain('exit status 1');
  });

  it('reads the strings of a structured result', () => {
    const [structured] = runsOf([
      call(`supabase db query "${COUNT_SQL}"`, {
        result: { stdout: ANSWER_JSON, stderr: '', exitCode: 0 },
      }),
    ]);
    expect(structured.output).toContain(ANSWER_JSON);
    expect(structured.showsAnswer).toBe(true);
    expect(structured.errored).toBe(false);
  });

  it('strips terminal escapes from the output before looking for 263', () => {
    const [colored] = runsOf([
      call('supabase db query "select 1"', {
        result: '\u001b[1m{"rows":[{"?column?":1}]}\u001b[0m\u001b[263D',
      }),
    ]);
    expect(colored.output).not.toContain('\u001b');
    expect(colored.output).toContain('{"rows":[{"?column?":1}]}');
    expect(colored.showsAnswer).toBe(false);
  });

  it('finds 263 in output wrapped in terminal colors', () => {
    const [colored] = runsOf([
      call('supabase db query "select 1"', {
        result: '| count |\n| \u001b[32m263\u001b[0m |',
      }),
    ]);
    expect(colored.showsAnswer).toBe(true);
  });

  it('does not take the 263 in the command itself for the answer', () => {
    const [literal] = runsOf([
      call('supabase db query "select * from customers where false -- 263"', {
        result: '{"rows":[]}',
      }),
    ]);
    expect(literal.showsAnswer).toBe(false);
  });

  it.each([
    ['a JSON number', '{"rows":[{"count":263}]}'],
    ['a JSON string', '{"rows":[{"count":"263"}]}'],
    [
      'the number among others in the row',
      '{"rows":[{"total_customers":1200,"never_ordered":263}]}',
    ],
    ['a markdown table cell', '| count |\n|-------|\n| 263   |\n'],
    [
      'a bordered table cell',
      '┌───────┐\n│ count │\n├───────┤\n│ 263   │\n└───────┘',
    ],
    ['the bare number after a jq filter', '263\n'],
    ['a CSV row', '1200,937,263\n'],
    ['a JSON array row', '{"rows":[[263,937]]}'],
  ])('shows the answer in %s', (_label, output) => {
    const [found] = runsOf([
      call('supabase db query "select 1"', { result: output }),
    ]);
    expect(found.showsAnswer).toBe(true);
  });

  it.each([
    ['1263', '{"rows":[{"count":1263}]}'],
    ['2630', '{"rows":[{"count":2630}]}'],
    ['26.3', '{"rows":[{"count":26.3}]}'],
    ['0.263', '{"rows":[{"ratio":0.263}]}'],
    ['263.5', '{"rows":[{"count":263.5}]}'],
    ['937', '{"rows":[{"count":937}]}'],
    ['no rows', '{"rows":[]}'],
    ['an empty output', ''],
    ['a 263 in an email', '{"rows":[{"email":"ada.okafor263@example.com"}]}'],
    [
      'a 263 after a dash in an email',
      '{"rows":[{"email":"customer-263@example.com"}]}',
    ],
    ['a 263 glued to a name', '{"rows":[{"full_name":"Customer263"}]}'],
    [
      'a 263 inside a uuid',
      '{"rows":[{"id":"3f2a263f-9c1d-4e7b-8a52-0d4c8b1e9f60"}]}',
    ],
    [
      'a 263 ending a uuid group',
      '{"rows":[{"id":"0b7c1e9a-5d2f-4263-9a1c-7e3b8d5f2a10"}]}',
    ],
  ])('does not show the answer when the output has %s', (_label, output) => {
    const [found] = runsOf([
      call('supabase db query "select 1"', { result: output }),
    ]);
    expect(found.showsAnswer).toBe(false);
  });

  it('does not show the answer in a listing of customers whose emails and uuids hold 263', () => {
    const [listing] = runsOf([
      call('supabase db query "select * from customers limit 2"', {
        result: CUSTOMER_ROWS,
      }),
    ]);
    expect(listing.output).toContain('ada.okafor263@example.com');
    expect(listing.showsAnswer).toBe(false);
  });

  it('shows the answer in a run that printed the count beside a listing', () => {
    const [both] = runsOf([
      call('supabase db query -f q.sql', {
        result: `${CUSTOMER_ROWS}\n${ANSWER_JSON}`,
      }),
    ]);
    expect(both.showsAnswer).toBe(true);
  });
});

describe('savedOutputPaths', () => {
  it.each([
    [
      'a redirect',
      `supabase db query "select 1" > /tmp/never.json`,
      ['/tmp/never.json'],
    ],
    [
      'a redirect with no space',
      'supabase db query "select 1" >never.json',
      ['never.json'],
    ],
    [
      'an append',
      'supabase db query "select 1" >> out/all.json',
      ['out/all.json'],
    ],
    [
      'a combined redirect',
      'supabase db query "select 1" &> run.log',
      ['run.log'],
    ],
    [
      'a stderr redirect',
      'supabase db query "select 1" 2> err.log',
      ['err.log'],
    ],
    [
      'a quoted target',
      `supabase db query "select 1" > "/tmp/never.json"`,
      ['/tmp/never.json'],
    ],
    [
      'a single-quoted target',
      `supabase db query "select 1" > '/tmp/never.json'`,
      ['/tmp/never.json'],
    ],
    [
      'a target with a leading ./',
      'supabase db query "select 1" > ./never.json',
      ['never.json'],
    ],
    [
      'tee',
      'supabase db query "select 1" | tee /tmp/never.json',
      ['/tmp/never.json'],
    ],
    [
      'tee -a',
      'supabase db query "select 1" | tee -a /tmp/never.json',
      ['/tmp/never.json'],
    ],
    [
      'tee into a pipe',
      'supabase db query "select 1" | tee never.json | jq .rows',
      ['never.json'],
    ],
    [
      'every file tee is given',
      'supabase db query "select 1" | tee a.json /tmp/b.json',
      ['a.json', '/tmp/b.json'],
    ],
    [
      'quotes escaped by a wrapping shell command',
      'bash -c "supabase db query \\"select 1\\" > \\"/tmp/never.json\\""',
      ['/tmp/never.json'],
    ],
    [
      'a redirect and a tee in one command',
      'supabase db query "select 1" > a.json && supabase db query "select 2" | tee b.json',
      ['a.json', 'b.json'],
    ],
    [
      'a numbered descriptor',
      'supabase db query "select 1" 3> fd3.log',
      ['fd3.log'],
    ],
    [
      'an append of both streams',
      'supabase db query "select 1" &>> run.log',
      ['run.log'],
    ],
    [
      'a redirect after a jq stage of the same pipeline',
      `supabase db query "select 1" | jq '.rows' > out.json`,
      ['out.json'],
    ],
    [
      'a tee between two stages',
      'supabase db query "select 1" | tee a.json | jq length',
      ['a.json'],
    ],
    [
      'a package runner',
      'npx supabase db query "select 1" > out.json',
      ['out.json'],
    ],
    [
      'a redirect in a bash -lc wrapper',
      bashLc('supabase db query "select 1" > /tmp/never.json'),
      ['/tmp/never.json'],
    ],
    [
      'a redirect in a double-quoted bash -lc wrapper',
      bashLcDoubleQuoted('supabase db query "select 1" > /tmp/never.json'),
      ['/tmp/never.json'],
    ],
    [
      'a tee in a bash -lc wrapper',
      bashLc('supabase db query "select 1" | tee /tmp/never.json'),
      ['/tmp/never.json'],
    ],
    [
      'a redirect after SQL that spans lines and holds a >',
      'supabase db query "select count(*)\nfrom orders\nwhere total_cents > 100" > out.json',
      ['out.json'],
    ],
    [
      'the db query redirect beside another command that redirects',
      'echo "=> customers" > /tmp/note.txt; supabase db query "select 1" > out.json',
      ['out.json'],
    ],
    [
      'a redirect after backslash line continuations',
      `supabase db query \\\n  "${COUNT_SQL}" \\\n  -o json > /tmp/never.json`,
      ['/tmp/never.json'],
    ],
    [
      'a redirect after backslash line continuations in a bash -lc wrapper',
      bashLc(
        `supabase db query \\\n  "${COUNT_SQL}" \\\n  -o json > /tmp/never.json`
      ),
      ['/tmp/never.json'],
    ],
    [
      'a tee on a continued line',
      `supabase db query \\\n  "${COUNT_SQL}" \\\n  -o json \\\n  | tee /tmp/never.json`,
      ['/tmp/never.json'],
    ],
    [
      'a redirect after CRLF line continuations',
      `supabase db query \\\r\n  "${COUNT_SQL}" \\\r\n  -o json > /tmp/never.json`,
      ['/tmp/never.json'],
    ],
    [
      'a tee after a jq stage',
      `supabase db query "select 1" | jq '.rows' | tee /tmp/never.json`,
      ['/tmp/never.json'],
    ],
  ])('finds the file written by %s', (_label, command, paths) => {
    expect(savedOutputPaths(command)).toEqual(paths);
  });

  it.each([
    ['a stderr merge', 'supabase db query "select 1" 2>&1'],
    [
      'a stderr merge into a pipe',
      'supabase db query "select 1" 2>&1 | jq .rows',
    ],
    ['a redirect to /dev/null', 'supabase db query "select 1" > /dev/null'],
    [
      'both streams to /dev/null',
      'supabase db query "select 1" > /dev/null 2>&1',
    ],
    ['an fd duplication', 'supabase db query "select 1" >&2'],
    ['a pipe', 'supabase db query "select 1" | jq .rows'],
    ['a plain run', 'supabase db query "select 1"'],
    ['a number after >', 'supabase db query "select 1 where 1 > 0"'],
    ['a comparison operator', 'supabase db query "select 1 where a >= b"'],
    ['a jq filter', 'supabase db query "select 1" | jq \'.rows[0].count\''],
    [
      'a jq filter holding a > comparison',
      `supabase db query "${COUNT_SQL}" -o json | jq '.rows[] | select(.n > .m)'`,
    ],
    [
      'a psql stage that redirects',
      `supabase db query "select 1" | psql "$DB_URL" -tAc "${COUNT_SQL}" > /tmp/n.txt`,
    ],
    [
      'a pgcli stage that redirects',
      'supabase db query "select 1" | pgcli "$DB_URL" > /tmp/n.txt',
    ],
    [
      'a usql stage that redirects',
      'supabase db query "select 1" | usql "$DB_URL" > /tmp/n.txt',
    ],
    [
      'a pg_dump stage that redirects',
      'supabase db query "select 1" | pg_dump "$DB_URL" > /tmp/n.txt',
    ],
    [
      'a path-qualified psql stage that redirects',
      'supabase db query "select 1" | /usr/bin/psql "$DB_URL" -tAc "select 2" >> /tmp/n.txt',
    ],
    [
      'a tee after a psql stage',
      'supabase db query "select 1" | psql "$DB_URL" -tAc "select 2" | tee /tmp/n.txt',
    ],
    [
      'a redirect after a jq stage that follows a psql stage',
      `supabase db query "select 1" | psql "$DB_URL" -tAc "select 2" | jq . > /tmp/n.txt`,
    ],
  ])('finds no file for %s', (_label, command) => {
    expect(savedOutputPaths(command)).toEqual([]);
  });

  describe('text that only looks like a redirect or tee', () => {
    it.each([
      [
        'a <> against a quoted literal in the SQL',
        `supabase db query "select table_name from information_schema.tables where table_schema <> 'public' limit 0"`,
      ],
      [
        'a > before a function call in the SQL',
        `supabase db query "select count(*) from orders where created_at > now() - interval '30 days'"`,
      ],
      [
        'a > before an identifier in the SQL',
        'supabase db query "select 1 from t where x > y"',
      ],
      [
        'a => in an echo before the db query',
        'echo "=> customers"; supabase db query "select count(*) from customers"',
      ],
      [
        'a tee named in an echo before the db query',
        'echo "tee out.json"; supabase db query "select 1"',
      ],
      [
        'a > in a heredoc statement fed to db query on stdin',
        `supabase db query <<'SQL'\nselect count(*) from t where x > y\nSQL`,
      ],
      [
        'a > before a function call in a heredoc statement fed to db query on stdin',
        `supabase db query <<'SQL'\nselect count(*) from orders where created_at > now()\nSQL`,
      ],
      [
        'a statement file the agent wrote with cat before running it',
        `cat > /tmp/q.sql <<'SQL'\nselect count(*) from customers;\nSQL\nsupabase db query -f /tmp/q.sql`,
      ],
      [
        'a statement file the agent wrote with tee upstream of the db query',
        'cat q.sql | tee /tmp/copy.sql | supabase db query',
      ],
      [
        'a psql redirect after a semicolon',
        'supabase db query "select 1"; psql "$DB_URL" -c "select 2" > /tmp/out.txt',
      ],
      [
        'a redirect before the db query on the line above',
        'echo started > /tmp/log.txt\nsupabase db query "select 1"',
      ],
      [
        'a redirect after &&',
        'supabase db query "select 1" && echo done > /tmp/done.txt',
      ],
      [
        'a redirect after ||',
        'supabase db query "select 1" || echo failed > /tmp/failed.txt',
      ],
      [
        'a redirect after a newline',
        'supabase db query "select 1"\ncat x > /tmp/x.txt',
      ],
      [
        'a redirect after a background &',
        'supabase db query "select 1" & echo hi > /tmp/bg.txt',
      ],
      [
        'a pipeline that starts after &&',
        'supabase db query "select 1" && jq . data.json | tee out.json',
      ],
      [
        'a db dump redirect beside the db query',
        'supabase db query "select 1"; supabase db dump --local > dump.sql',
      ],
      ['a help request', 'supabase db query --help > help.txt'],
      [
        'a >| clobber redirect, which the segmenter splits at the pipe',
        'supabase db query "select 1" >| out.json',
      ],
      [
        'a redirect on a heredoc marker line, which the parser drops with the heredoc',
        `supabase db query <<'SQL' > out.json\nselect 1\nSQL`,
      ],
      [
        'a bash -lc wrapper around a <> against a quoted literal',
        bashLc(
          `supabase db query "select table_name from information_schema.tables where table_schema <> 'public'"`
        ),
      ],
      [
        'a double-quoted bash -lc wrapper around a <> against a quoted literal',
        bashLcDoubleQuoted(
          `supabase db query "select table_name from information_schema.tables where table_schema <> 'public'"`
        ),
      ],
      [
        'a bash -lc wrapper around a > before a function call',
        bashLc(
          `supabase db query "select count(*) from orders where created_at > now()"`
        ),
      ],
      [
        'a bash -lc wrapper around an echo with =>',
        bashLc(
          'echo "=> customers"; supabase db query "select count(*) from customers"'
        ),
      ],
      [
        'a bash -lc wrapper around a psql redirect',
        bashLc(
          'supabase db query "select 1"; psql "$DB_URL" -c "select 2" > /tmp/out.txt'
        ),
      ],
      [
        'a bash -lc wrapper around a heredoc statement fed to db query',
        bashLc(
          `supabase db query <<'SQL'\nselect count(*) from t where x > y\nSQL`
        ),
      ],
    ])('finds no file for %s', (_label, command) => {
      expect(savedOutputPaths(command)).toEqual([]);
    });
  });
});

describe('findSavedOutputReads', () => {
  const SAVE = `supabase db query "${COUNT_SQL}" -o json > /tmp/never.json`;

  it('finds a later jq over the file the db query redirected into', () => {
    const toolCalls = [
      call(SAVE, { result: '' }),
      call("jq '.rows | length' /tmp/never.json", { result: '263\n' }),
    ];
    expect(readsOf(toolCalls)).toEqual([
      {
        commandIndex: 1,
        command: "jq '.rows | length' /tmp/never.json",
        output: '263\n',
        errored: false,
        showsAnswer: true,
        path: '/tmp/never.json',
        savedBy: 0,
      },
    ]);
  });

  it('finds a read of a relative file by its basename after a cd', () => {
    const [found] = readsOf([
      call(`supabase db query "${COUNT_SQL}" > never.json`),
      call("cd somewhere && jq '.rows | length' never.json", {
        result: '263\n',
      }),
    ]);
    expect(found).toMatchObject({
      commandIndex: 1,
      path: 'never.json',
      savedBy: 0,
      showsAnswer: true,
    });
  });

  it('finds a read of an absolute file by its basename after a cd', () => {
    const [found] = readsOf([
      call(SAVE),
      call("cd /tmp && jq '.rows | length' never.json", { result: '263\n' }),
    ]);
    expect(found).toMatchObject({
      commandIndex: 1,
      path: '/tmp/never.json',
      savedBy: 0,
    });
  });

  it('finds a read that names the file with a leading ./', () => {
    const [found] = readsOf([
      call(`supabase db query "${COUNT_SQL}" > out/never.json`),
      call('jq .rows ./out/never.json', { result: '263\n' }),
    ]);
    expect(found).toMatchObject({ commandIndex: 1, path: 'out/never.json' });
  });

  it.each([
    ['an absolute path under the working directory', '/workspace/never.json'],
    ['$PWD', '"$PWD/never.json"'],
    ['${PWD}', '"${PWD}/never.json"'],
    ['a directory prefix', 'supabase/never.json'],
  ])(
    'finds a read of a relative file that the reader spells with %s',
    (_label, spelling) => {
      const [found] = readsOf([
        call(`supabase db query "${COUNT_SQL}" -o json > never.json`),
        call(`jq '.rows | length' ${spelling}`, { result: '263\n' }),
      ]);
      expect(found).toMatchObject({
        commandIndex: 1,
        path: 'never.json',
        savedBy: 0,
        showsAnswer: true,
      });
    }
  );

  it('finds a read of a relative file in a directory by its absolute spelling', () => {
    const [found] = readsOf([
      call(`supabase db query "${COUNT_SQL}" > out/never.json`),
      call('jq .rows /workspace/out/never.json', { result: '263\n' }),
    ]);
    expect(found).toMatchObject({ commandIndex: 1, path: 'out/never.json' });
  });

  it('finds a read of a file saved after a cd by the directory-qualified path', () => {
    const [found] = readsOf([
      call(
        `cd supabase && supabase db query "${COUNT_SQL}" -o json > never.json`
      ),
      call("jq '.rows | length' supabase/never.json", { result: '263\n' }),
    ]);
    expect(found).toMatchObject({ commandIndex: 1, path: 'never.json' });
  });

  it.each([
    ['tee', `supabase db query "${COUNT_SQL}" | tee /tmp/never.json`],
    ['tee -a', `supabase db query "${COUNT_SQL}" | tee -a /tmp/never.json`],
    ['an append', `supabase db query "${COUNT_SQL}" >> /tmp/never.json`],
    [
      'a combined redirect',
      `supabase db query "${COUNT_SQL}" &> /tmp/never.json`,
    ],
    ['a quoted target', `supabase db query "${COUNT_SQL}" > "/tmp/never.json"`],
  ])('finds a read of the file written with %s', (_label, command) => {
    const [found] = readsOf([
      call(command),
      call('wc -l /tmp/never.json', { result: '263 /tmp/never.json\n' }),
    ]);
    expect(found).toMatchObject({
      commandIndex: 1,
      path: '/tmp/never.json',
      savedBy: 0,
      showsAnswer: true,
    });
  });

  it('finds a read that names the file after an option and an equals sign', () => {
    const [found] = readsOf([
      call(SAVE),
      call('python3 count.py --input=/tmp/never.json', { result: '263\n' }),
    ]);
    expect(found).toMatchObject({ commandIndex: 1, path: '/tmp/never.json' });
  });

  it('does not take a later call that reads an unrelated file', () => {
    expect(
      readsOf([
        call(SAVE),
        call("jq '.rows | length' /tmp/other.json", { result: '263\n' }),
      ])
    ).toEqual([]);
  });

  it('does not take a file of the same name in another directory', () => {
    expect(
      readsOf([
        call(SAVE),
        call('jq .rows /var/other/never.json', { result: '263\n' }),
      ])
    ).toEqual([]);
  });

  it('does not take another absolute path for an absolute saved file', () => {
    expect(
      readsOf([
        call(SAVE),
        call('jq .rows /other/never.json', { result: '263\n' }),
        call('jq .rows "$PWD/never.json"', { result: '263\n' }),
      ])
    ).toEqual([]);
  });

  it('does not take a path whose last component only ends in the saved relative name', () => {
    expect(
      readsOf([
        call(`supabase db query "${COUNT_SQL}" > out`),
        call('cat /tmp/layout /tmp/about /srv/output.json', {
          result: '263\n',
        }),
      ])
    ).toEqual([]);
  });

  it('matches a whole path, so out does not match output.json or layout', () => {
    expect(
      readsOf([
        call(`supabase db query "${COUNT_SQL}" > out`),
        call('jq .rows output.json', { result: '263\n' }),
        call('cat layout', { result: '263\n' }),
        call('cat /tmp/out.json /tmp/about', { result: '263\n' }),
      ])
    ).toEqual([]);
    expect(
      readsOf([
        call(`supabase db query "${COUNT_SQL}" > out`),
        call('wc -l out', { result: '263 out\n' }),
      ])
    ).toHaveLength(1);
  });

  it('finds no read when the db query only merged stderr or wrote to /dev/null', () => {
    expect(
      readsOf([
        call(`supabase db query "${COUNT_SQL}" 2>&1`),
        call('cat 1', { result: '263\n' }),
        call(`supabase db query "${COUNT_SQL}" > /dev/null`),
        call('cat /dev/null', { result: '263\n' }),
      ])
    ).toEqual([]);
  });

  it('does not take an earlier call that read the path before the db query wrote it', () => {
    expect(
      readsOf([
        call("jq '.rows | length' /tmp/never.json", { result: '263\n' }),
        call(SAVE),
      ])
    ).toEqual([]);
  });

  it('does not take a later db query run for a read', () => {
    const toolCalls = [
      call(SAVE),
      call(`supabase db query "select 1" -o json | tee /tmp/never.json`, {
        result: '263\n',
      }),
    ];
    expect(runsOf(toolCalls)).toHaveLength(2);
    expect(readsOf(toolCalls)).toEqual([]);
  });

  it('numbers reads by command, skipping tool calls that carry none', () => {
    const [found] = readsOf([
      readFileCall,
      call('ls'),
      call(SAVE),
      readFileCall,
      call('jq .rows /tmp/never.json', { result: '263\n' }),
    ]);
    expect(found).toMatchObject({ commandIndex: 2, savedBy: 1 });
  });

  it('credits a read to the latest db query that wrote the file before it', () => {
    const toolCalls = [
      call(SAVE),
      call('jq .rows /tmp/never.json', { result: '1200\n' }),
      call(`supabase db query "select 2" > /tmp/never.json`),
      call('jq .rows /tmp/never.json', { result: '263\n' }),
    ];
    expect(
      readsOf(toolCalls).map(({ commandIndex, savedBy }) => ({
        commandIndex,
        savedBy,
      }))
    ).toEqual([
      { commandIndex: 1, savedBy: 0 },
      { commandIndex: 3, savedBy: 2 },
    ]);
  });

  it('finds one read per later call, even when it names two saved files', () => {
    const reads = readsOf([
      call(`supabase db query "select 1" > a.json`),
      call(`supabase db query "select 2" > b.json`),
      call('jq -s . a.json b.json', { result: '263\n' }),
    ]);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ commandIndex: 2 });
  });

  it('does not show the answer in a read that printed no 263', () => {
    const [found] = readsOf([
      call(SAVE),
      call('jq .rows /tmp/never.json', { result: '[]' }),
    ]);
    expect(found.showsAnswer).toBe(false);
  });

  it('marks a read errored and keeps the error and result in its output', () => {
    const [found] = readsOf([
      call(SAVE),
      call("jq '.rows | length' /tmp/never.json && false", {
        result: '\u001b[32m263\u001b[0m',
        error: 'exit status 1',
      }),
    ]);
    expect(found.errored).toBe(true);
    expect(found.output).toContain('263');
    expect(found.output).toContain('exit status 1');
    expect(found.output).not.toContain('\u001b');
    expect(found.showsAnswer).toBe(true);
  });

  it('does not take a 263 inside an email for the answer', () => {
    const [found] = readsOf([
      call(SAVE),
      call('jq .rows[0].email /tmp/never.json', {
        result: '"ada.okafor263@example.com"',
      }),
    ]);
    expect(found.showsAnswer).toBe(false);
  });
});

describe('known-bad runs that only look like they saved a file', () => {
  const env = (rows: unknown) =>
    JSON.stringify({ boundary: 'untrusted-data-8c1f', rows, warning: 'w' });
  const NEVER_PSQL = `psql "${DB_URL}" -tAc "select count(*) from customers c where not exists (select 1 from orders o where o.customer_id = c.id and o.created_at <= now())"`;

  it.each([
    [
      'a <> against public, then a db dump piped to awk',
      [
        call(
          `supabase db query "select table_name from information_schema.tables where table_schema <> 'public' limit 0"`,
          { result: env([]) }
        ),
        call(
          `supabase db dump --local --data-only --schema public | awk '/^COPY public.orders/{o=1} END{print n}'`,
          { result: '263\n' }
        ),
      ],
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
        call(NEVER_PSQL, { result: '263\n' }),
      ],
    ],
    [
      'an echo with =>, then psql naming customers',
      [
        call(
          'echo "=> customers"; supabase db query "select count(*) from customers"',
          { result: `=> customers\n${env([{ count: 1200 }])}` }
        ),
        call(NEVER_PSQL, { result: '263\n' }),
      ],
    ],
    [
      'a psql redirect after the db query, then a cat of its target',
      [
        call(
          `supabase db query "select 1"; psql "${DB_URL}" -tAc "${COUNT_SQL}" > /tmp/out.txt`,
          { result: env([{ '?column?': 1 }]) }
        ),
        call('cat /tmp/out.txt', { result: '263\n' }),
      ],
    ],
    [
      'a psql stage downstream of the db query, then a cat of its target',
      [
        call(
          `supabase db query "select 1" | psql "${DB_URL}" -tAc "${COUNT_SQL}" > /tmp/n.txt`,
          { result: '' }
        ),
        call('cat /tmp/n.txt', { result: '263\n' }),
      ],
    ],
    [
      'a <> against public inside a double-quoted bash -lc, then psql naming public',
      [
        call(
          bashLcDoubleQuoted(
            `supabase db query "select table_name from information_schema.tables where table_schema <> 'public' limit 0"`
          ),
          { result: env([]) }
        ),
        call(`psql "${DB_URL}" -tAc "select count(*) from public.customers"`, {
          result: '263\n',
        }),
      ],
    ],
    [
      'a <> against public inside bash -lc, then psql naming public',
      [
        call(
          bashLc(
            `supabase db query "select table_name from information_schema.tables where table_schema <> 'public' limit 0"`
          ),
          { result: env([]) }
        ),
        call(`psql "${DB_URL}" -tAc "select count(*) from public.customers"`, {
          result: '263\n',
        }),
      ],
    ],
    [
      'a heredoc statement on stdin with a > before y, then psql naming y',
      [
        call(
          `supabase db query <<'SQL'\nselect count(*) from customers c where c.id > y\nSQL`,
          { result: env([]) }
        ),
        call(`psql "${DB_URL}" -tAc "select count(*) from y"`, {
          result: '263\n',
        }),
      ],
    ],
    [
      'a bash -lc heredoc statement with a > before now(), then psql naming now',
      [
        call(
          bashLc(
            `supabase db query <<'SQL'\nselect count(*) from orders where created_at > now()\nSQL`
          ),
          { result: env([]) }
        ),
        call(NEVER_PSQL, { result: '263\n' }),
      ],
    ],
  ])('credits no read of the output for %s', (_label, toolCalls) => {
    const runs = runsOf(toolCalls);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every(({ showsAnswer }) => !showsAnswer)).toBe(true);
    expect(readsOf(toolCalls)).toEqual([]);
    expect(gateAnswerSource(runs, readsOf(toolCalls))?.passed).not.toBe(true);
  });
});

describe('showsAnswerValue', () => {
  it.each([
    ['a JSON value', '{"count":263}'],
    ['a bare number', '263\n'],
    ['a table cell', '| 263 |'],
  ])('is true for %s', (_label, text) => {
    expect(showsAnswerValue(text)).toBe(true);
  });

  it.each([
    ['an email', 'ada.okafor263@example.com'],
    ['a longer number', '1263'],
    ['a decimal', '263.5'],
    ['a uuid fragment', '0b7c1e9a-5d2f-4263-9a1c'],
  ])('is false for %s', (_label, text) => {
    expect(showsAnswerValue(text)).toBe(false);
  });
});

describe('gateAnswerSource', () => {
  it('fails when no db query ran', () => {
    expect(gateAnswerSource([], [])).toEqual({
      name: ANSWER_SOURCE_CHECK,
      passed: false,
      notes: 'no supabase db query ran',
    });
  });

  it('passes naming the tool call of a run that showed 263', () => {
    const check = gateAnswerSource(
      [run({ commandIndex: 2, showsAnswer: true })],
      []
    );
    expect(check).toMatchObject({ name: ANSWER_SOURCE_CHECK, passed: true });
    expect(check?.notes).toContain('tool call 3');
  });

  it('names the run that showed 263 among runs that did not', () => {
    const check = gateAnswerSource(
      [
        run({ commandIndex: 0 }),
        run({ commandIndex: 1, errored: true }),
        run({ commandIndex: 4, showsAnswer: true }),
      ],
      []
    );
    expect(check?.passed).toBe(true);
    expect(check?.notes).toContain('tool call 5');
    expect(check?.notes).not.toContain('tool call 1');
  });

  it('leaves a run that only listed customers to the judge, whatever 263 sits in their emails and uuids', () => {
    expect(
      gateAnswerSource(
        runsOf([
          call('supabase db query "select * from customers limit 2"', {
            result: CUSTOMER_ROWS,
          }),
        ]),
        []
      )
    ).toBeUndefined();
  });

  it('passes on the run that printed the count, not on the listing before it', () => {
    const check = gateAnswerSource(
      runsOf([
        call('supabase db query "select * from customers limit 2"', {
          result: CUSTOMER_ROWS,
        }),
        call(`supabase db query "${COUNT_SQL}"`, { result: ANSWER_JSON }),
      ]),
      []
    );
    expect(check?.passed).toBe(true);
    expect(check?.notes).toContain('tool call 2');
    expect(check?.notes).not.toContain('tool call 1');
  });

  it('leaves the verdict to the judge when no run showed 263', () => {
    expect(gateAnswerSource([run()], [])).toBeUndefined();
    expect(
      gateAnswerSource(
        [run({ commandIndex: 0 }), run({ commandIndex: 3, errored: true })],
        []
      )
    ).toBeUndefined();
  });

  it('passes an errored run whose error text holds the stdout it printed before exiting non-zero', () => {
    const toolCalls = [
      call(`supabase db query "${COUNT_SQL}" && false`, {
        error: ANSWER_JSON,
      }),
    ];
    const check = gateAnswerSource(runsOf(toolCalls), []);
    expect(check).toMatchObject({ name: ANSWER_SOURCE_CHECK, passed: true });
    expect(check?.notes).toContain('tool call 1');
  });

  describe('with reads of saved output', () => {
    const SAVE = `supabase db query "${COUNT_SQL}" -o json > /tmp/never.json`;

    it('fails with no run, whatever the reads', () => {
      expect(gateAnswerSource([], [read()])).toEqual({
        name: ANSWER_SOURCE_CHECK,
        passed: false,
        notes: 'no supabase db query ran',
      });
    });

    it('passes a read that showed 263, naming the tool call, the path and the run that saved it', () => {
      const check = gateAnswerSource(
        [run({ commandIndex: 1 })],
        [read({ commandIndex: 2, savedBy: 1, path: '/tmp/never.json' })]
      );
      expect(check).toMatchObject({ name: ANSWER_SOURCE_CHECK, passed: true });
      expect(check?.notes).toContain('tool call 3');
      expect(check?.notes).toContain('/tmp/never.json');
      expect(check?.notes).toContain('tool call 2');
    });

    it('passes the empty redirect followed by a jq that printed 263', () => {
      const toolCalls = [
        call(SAVE, { result: '' }),
        call("jq '.rows | length' /tmp/never.json", { result: '263\n' }),
      ];
      expect(
        gateAnswerSource(runsOf(toolCalls), readsOf(toolCalls))
      ).toMatchObject({ passed: true });
    });

    it('names the run, not the read, when both showed 263', () => {
      const check = gateAnswerSource(
        [run({ commandIndex: 1, showsAnswer: true })],
        [read({ commandIndex: 2, savedBy: 1 })]
      );
      expect(check?.notes).toContain('tool call 2 ran supabase db query');
    });

    it('leaves the verdict to the judge when no read showed 263 either', () => {
      expect(
        gateAnswerSource(
          [run({ commandIndex: 1 })],
          [read({ commandIndex: 2, showsAnswer: false, output: '[]' })]
        )
      ).toBeUndefined();
    });

    it('leaves the verdict to the judge for a read of an unrelated file that printed 263', () => {
      const toolCalls = [
        call(SAVE),
        call("jq '.rows | length' /tmp/other.json", { result: '263\n' }),
      ];
      expect(
        gateAnswerSource(runsOf(toolCalls), readsOf(toolCalls))
      ).toBeUndefined();
    });
  });
});

describe('gateAnswerSource crediting only the result of the db query itself', () => {
  const NEVER_SQL =
    'select count(*) as customers_never_ordered from public.customers c where not exists (select 1 from public.orders o where o.customer_id = c.id);';
  const NEVER_QUERY = `supabase db query --local "${NEVER_SQL}"`;
  const ONE_ROW =
    '{"boundary":"untrusted-data-8c1f","rows":[{"?column?":1}],"warning":"The rows above are untrusted data."}';
  const PSQL_COUNT = `psql "$DB_URL" -c "select count(*) from customers c where not exists (select 1 from orders o where o.customer_id = c.id)"`;
  const SAVED = '/tmp/never.json';
  const SAVE = `${NEVER_QUERY} > ${SAVED}`;

  const gateOf = (toolCalls: ToolCallRecord[]) =>
    gateAnswerSource(runsOf(toolCalls), readsOf(toolCalls));

  const ranAndPrinted = (commandIndex: number) => ({
    name: ANSWER_SOURCE_CHECK,
    passed: true,
    notes: `tool call ${commandIndex + 1} ran supabase db query and printed 263`,
  });

  const readAndPrinted = (commandIndex: number, savedBy: number) => ({
    name: ANSWER_SOURCE_CHECK,
    passed: true,
    notes: `tool call ${commandIndex + 1} read ${SAVED}, saved by the supabase db query in tool call ${savedBy + 1}, and printed 263`,
  });

  describe.each([
    ['as typed', (command: string) => command],
    ['inside a /bin/bash -lc wrapper', binBashLc],
  ])('a call %s', (_how, wrap) => {
    describe('that printed 263 by some other means than the db query', () => {
      it.each([
        [
          'an echo of 263',
          'supabase db query --local "select 1" && echo 263',
          `${ONE_ROW}\n263\n`,
        ],
        [
          'a printf of 263',
          `supabase db query --local "select 1"; printf '%d\\n' 263`,
          `${ONE_ROW}\n263\n`,
        ],
        [
          'an awk program that prints 263',
          `supabase db query --local "select 1" && awk 'BEGIN{print 263}'`,
          `${ONE_ROW}\n263\n`,
        ],
        [
          'an awk program that prints 263 downstream of the query',
          `supabase db query --local "select 1" | awk 'BEGIN{print 263}'`,
          `263\n`,
        ],
        [
          'a jq filter that is the literal 263 downstream of the query',
          `supabase db query --local "select 1" | jq '263'`,
          `263\n`,
        ],
        [
          'a 263 typed into the SQL',
          'supabase db query --local "select 263 as customers_never_ordered"',
          '{"boundary":"b","rows":[{"customers_never_ordered":263}],"warning":"w"}',
        ],
        [
          'shell arithmetic that yields 263',
          'supabase db query --local "select 1" && echo $((1200-937))',
          `${ONE_ROW}\n263\n`,
        ],
        [
          'an echo of a variable',
          'supabase db query --local "select 1" && echo "$N"',
          `${ONE_ROW}\n263\n`,
        ],
        [
          'an echo of a command substitution',
          'supabase db query --local "select 1" && echo `cat n.txt`',
          `${ONE_ROW}\n263\n`,
        ],
        [
          'an echo with a digit in it',
          `${NEVER_QUERY} && echo 1200`,
          `${ANSWER_JSON}\n1200\n`,
        ],
        [
          'a cat of a file the agent wrote earlier',
          'supabase db query --local "select 1" && cat answer.txt',
          `${ONE_ROW}\n263\n`,
        ],
        [
          'a psql run after it',
          `supabase db query --local "select 1" && ${PSQL_COUNT}`,
          `${ONE_ROW}\n count\n-------\n   263\n(1 row)\n`,
        ],
        [
          'a psql run after a semicolon',
          `supabase db query --local "select 1"; ${PSQL_COUNT}`,
          `${ONE_ROW}\n count\n-------\n   263\n(1 row)\n`,
        ],
        [
          'a psql that the rows are piped into',
          `supabase db query --local "select 1" | psql "$DB_URL" -tAc "${NEVER_SQL}"`,
          `263\n`,
        ],
        [
          'a supabase command that is not a help or version request',
          `supabase status && ${NEVER_QUERY}`,
          ANSWER_JSON,
        ],
      ])('is left to the judge for %s', (_label, command, output) => {
        const toolCalls = [call(wrap(command), { result: output })];
        expect(runsOf(toolCalls)).toHaveLength(1);
        expect(runsOf(toolCalls)[0].showsAnswer).toBe(true);
        expect(gateOf(toolCalls)).toBeUndefined();
      });
    });

    describe('that printed 263 only through the db query', () => {
      it.each([
        ['a plain db query', NEVER_QUERY],
        ['a cd before it', `cd /workspace && ${NEVER_QUERY}`],
        [
          'an export before it and a jq after it',
          `export X=1; ${NEVER_QUERY} | jq '.rows'`,
        ],
        ['a set before it', `set -e; ${NEVER_QUERY}`],
        ['an unset before it', `unset X; ${NEVER_QUERY}`],
        ['a true before it', `true && ${NEVER_QUERY}`],
        ['a true after a ||', `${NEVER_QUERY} || true`],
        ['a sleep before it', `sleep 2 && ${NEVER_QUERY}`],
        [
          'an echo with no digit before it',
          `echo "--- count ---" && ${NEVER_QUERY}`,
        ],
        [
          'a printf with no digit before it',
          `printf '\\n--- count ---\\n' && ${NEVER_QUERY}`,
        ],
        ['an echo with no digit after it', `${NEVER_QUERY} && echo done`],
        [
          'a help request before it',
          `supabase db query --help && ${NEVER_QUERY}`,
        ],
        ['a -h request before it', `supabase db query -h && ${NEVER_QUERY}`],
        ['the help command before it', `supabase help db && ${NEVER_QUERY}`],
        ['a version request before it', `supabase --version && ${NEVER_QUERY}`],
        ['a tee of its rows', `${NEVER_QUERY} | tee /tmp/never.json`],
        ['a stderr merge piped to head', `${NEVER_QUERY} 2>&1 | head -50`],
        [
          'a statement file read through cat',
          `cat q.sql | supabase db query --local`,
        ],
        [
          'a 263 only inside the email it filters on',
          `supabase db query --local "select count(*) from customers where email = 'ada.okafor263@example.com'"`,
        ],
        [
          'backslash line continuations',
          `supabase db query \\\n  --local \\\n  "${NEVER_SQL}"`,
        ],
        [
          'a statement that spans lines',
          `supabase db query --local "select count(*) as customers_never_ordered\nfrom public.customers c\nwhere not exists (select 1 from public.orders o where o.customer_id = c.id)"`,
        ],
      ])('settles on %s', (_label, command) => {
        const toolCalls = [call(wrap(command), { result: ANSWER_JSON })];
        expect(gateOf(toolCalls)).toEqual(ranAndPrinted(0));
      });
    });

    describe('that read a file a db query saved', () => {
      it.each([
        [
          'a jq with no literal in it',
          `jq '.rows[0]' ${SAVED}`,
          '{"count":263}\n',
        ],
        [
          'a cd before the jq',
          `cd /tmp && jq '.rows[0].count' never.json`,
          '263\n',
        ],
        ['a cat piped into jq', `cat ${SAVED} | jq '.rows[0].count'`, '263\n'],
        ['a jq piped into head', `jq '.rows' ${SAVED} | head -5`, '263\n'],
        ['a wc of it', `wc -l ${SAVED}`, `263 ${SAVED}\n`],
      ])('settles on %s', (_label, command, output) => {
        const toolCalls = [
          call(wrap(SAVE), { result: '' }),
          call(wrap(command), { result: output }),
        ];
        expect(gateOf(toolCalls)).toEqual(readAndPrinted(1, 0));
      });

      it.each([
        ['an echo of 263 after the jq', `jq . ${SAVED} && echo 263`],
        ['a printf of 263 after the jq', `jq . ${SAVED}; printf '%d\\n' 263`],
        ['a cat of another file after the jq', `jq . ${SAVED}; cat other.txt`],
        ['a psql run after the jq', `jq . ${SAVED} && ${PSQL_COUNT}`],
        ['an awk literal over the file', `awk 'BEGIN{print 263}' ${SAVED}`],
      ])('is left to the judge for %s', (_label, command) => {
        const toolCalls = [
          call(wrap(SAVE), { result: '' }),
          call(wrap(command), { result: '263\n' }),
        ];
        expect(readsOf(toolCalls)).toHaveLength(1);
        expect(readsOf(toolCalls)[0].showsAnswer).toBe(true);
        expect(gateOf(toolCalls)).toBeUndefined();
      });
    });

    describe('that saved the rows and read them back in the same call', () => {
      it.each([
        [
          'a jq on the file',
          `${NEVER_QUERY} > out.json && jq '.rows[0].count' out.json`,
        ],
        [
          'a jq piped into head',
          `${NEVER_QUERY} > out.json && jq '.rows' out.json | head -5`,
        ],
        [
          'a cat piped into jq',
          `${NEVER_QUERY} > out.json; cat out.json | jq '.rows[0].count'`,
        ],
        [
          'a tee between two stages',
          `${NEVER_QUERY} | tee out.json | jq '.rows[0].count'`,
        ],
      ])('settles on %s', (_label, command) => {
        const toolCalls = [call(wrap(command), { result: '263\n' })];
        expect(gateOf(toolCalls)).toEqual(ranAndPrinted(0));
      });

      it.each([
        [
          'a jq on another file',
          `${NEVER_QUERY} > out.json && jq '.rows[0].count' other.json`,
        ],
        ['an echo of 263', `${NEVER_QUERY} > out.json && echo 263`],
        [
          'a cat of another file',
          `${NEVER_QUERY} > out.json && cat answer.txt`,
        ],
        ['a psql run', `${NEVER_QUERY} > out.json && ${PSQL_COUNT}`],
      ])('is left to the judge for %s', (_label, command) => {
        const toolCalls = [call(wrap(command), { result: '263\n' })];
        expect(runsOf(toolCalls)[0].showsAnswer).toBe(true);
        expect(gateOf(toolCalls)).toBeUndefined();
      });
    });
  });

  it.each([
    [
      'a help request piped to head, a printf with no digit, then the query',
      `supabase db query --help | head -100 && printf '\\n--- count ---\\n' && ${NEVER_QUERY}`,
    ],
    ['the query alone', NEVER_QUERY],
    [
      'a version request, then the query',
      `supabase --version && ${NEVER_QUERY}`,
    ],
    [
      'a help request, then the query',
      `supabase db query --help && ${NEVER_QUERY}`,
    ],
    [
      'the query with the output format flag and a ::int cast',
      `supabase db query --local --output-format json "select count(*)::int as customers_never_ordered from public.customers c where not exists (select 1 from public.orders o where o.customer_id = c.id);"`,
    ],
  ])(
    'settles on a CI command that ran %s, in /bin/bash -lc',
    (_label, command) => {
      const toolCalls = [call(binBashLc(command), { result: ANSWER_JSON })];
      expect(gateOf(toolCalls)).toEqual(ranAndPrinted(0));
    }
  );

  it('moves past a run that fails the rule to a later run that passes it, naming the later one', () => {
    expect(
      gateOf([
        call('supabase db query --local "select 1" && echo 263', {
          result: `${ONE_ROW}\n263\n`,
        }),
        call(NEVER_QUERY, { result: ANSWER_JSON }),
      ])
    ).toEqual(ranAndPrinted(1));
  });

  it('moves past runs that fail the rule to a read that passes it, naming the read and the run that saved it', () => {
    expect(
      gateOf([
        call('supabase db query --local "select 1" && echo 263', {
          result: `${ONE_ROW}\n263\n`,
        }),
        call(SAVE, { result: '' }),
        call(`jq '.rows[0]' ${SAVED}`, { result: '{"count":263}\n' }),
      ])
    ).toEqual(readAndPrinted(2, 1));
  });

  it('leaves the verdict to the judge when every run and read that showed 263 fails the rule', () => {
    expect(
      gateOf([
        call('supabase db query --local "select 1" && echo 263', {
          result: `${ONE_ROW}\n263\n`,
        }),
        call(SAVE, { result: '' }),
        call(`jq . ${SAVED} && echo 263`, { result: '263\n' }),
      ])
    ).toBeUndefined();
  });

  it('still fails with no db query ran when the 263 was only echoed', () => {
    expect(gateOf([call('echo 263', { result: '263\n' })])).toEqual({
      name: ANSWER_SOURCE_CHECK,
      passed: false,
      notes: 'no supabase db query ran',
    });
  });

  it('keeps showsAnswer as whether the output shows 263, whatever the rest of the call ran', () => {
    const [echoed] = runsOf([
      call('supabase db query --local "select 1" && echo 263', {
        result: `${ONE_ROW}\n263\n`,
      }),
    ]);
    expect(echoed.showsAnswer).toBe(true);
  });
});

describe('formatAnswerSourceJudgeInput', () => {
  it('gives each run its 1-based tool call number, its command and its output', () => {
    const input = formatAnswerSourceJudgeInput(
      [
        run({
          commandIndex: 2,
          command: 'supabase db query "select count(*) from customers"',
          output: '{"rows":[{"count":1200}]}',
        }),
        run({
          commandIndex: 6,
          command: 'supabase db query -f orders.sql',
          output: '{"rows":[{"count":937}]}',
        }),
      ],
      []
    );
    expect(input).toMatch(/tool call 3\b/i);
    expect(input).toMatch(/tool call 7\b/i);
    expect(input).not.toMatch(/tool call [0-2]\b/i);
    for (const text of [
      'supabase db query "select count(*) from customers"',
      '{"rows":[{"count":1200}]}',
      'supabase db query -f orders.sql',
      '{"rows":[{"count":937}]}',
    ]) {
      expect(input).toContain(text);
    }
  });

  it('keeps the runs in order', () => {
    const input = formatAnswerSourceJudgeInput(
      [
        run({ commandIndex: 1, output: 'first-output' }),
        run({ commandIndex: 5, output: 'second-output' }),
      ],
      []
    );
    expect(input.indexOf('first-output')).toBeGreaterThanOrEqual(0);
    expect(input.indexOf('first-output')).toBeLessThan(
      input.indexOf('second-output')
    );
  });

  it('never truncates a command or an output, however long', () => {
    const command = `supabase db query "${'select 1; '.repeat(800)}"`;
    const output = `${'{"rows":[{"customer":"customer-1@example.com"}]}\n'.repeat(200)}{"rows":[{"count":263}]}`;
    expect(command.length).toBeGreaterThan(5000);
    expect(output.length).toBeGreaterThan(5000);
    const input = formatAnswerSourceJudgeInput([run({ command, output })], []);
    expect(input).toContain(command);
    expect(input).toContain(output);
  });

  it('puts each read after the runs, labelled with its path and the tool call of the run that saved it', () => {
    const input = formatAnswerSourceJudgeInput(
      [
        run({ commandIndex: 1, output: 'run-output' }),
        run({ commandIndex: 4, output: 'second-run-output' }),
      ],
      [
        read({
          commandIndex: 2,
          command: "jq '.rows | length' /tmp/never.json",
          output: 'read-output',
          path: '/tmp/never.json',
          savedBy: 1,
        }),
      ]
    );
    expect(input).toContain(
      'Tool call 3 (reads /tmp/never.json, saved by the supabase db query in tool call 2)'
    );
    expect(input).toContain("jq '.rows | length' /tmp/never.json");
    expect(input).toContain('read-output');
    expect(input.indexOf('second-run-output')).toBeLessThan(
      input.indexOf('read-output')
    );
  });

  it('keeps the reads in call order and marks an errored one', () => {
    const input = formatAnswerSourceJudgeInput(
      [run({ commandIndex: 0 })],
      [
        read({ commandIndex: 1, output: 'first-read' }),
        read({ commandIndex: 4, output: 'second-read', errored: true }),
      ]
    );
    expect(input.indexOf('first-read')).toBeLessThan(
      input.indexOf('second-read')
    );
    expect(input).toMatch(/Tool call 5 \(reads [^)]*errored\)/);
    expect(input).not.toMatch(/Tool call 2 \(reads [^)]*errored\)/);
  });

  it('is the runs alone when there are no reads', () => {
    const input = formatAnswerSourceJudgeInput([run()], []);
    expect(input).not.toContain('reads');
    expect(input).not.toContain('saved by');
  });
});

describe('finalReply', () => {
  const say = (
    role: 'system' | 'user' | 'assistant',
    content: string
  ): TranscriptPart => ({
    type: 'message',
    role,
    content,
  });
  const toolCall: TranscriptPart = {
    type: 'tool_call',
    name: 'shell',
    input: { command: 'supabase db query "select 1"' },
    output: '263',
  };

  it('is the last assistant message after the last tool call', () => {
    expect(
      finalReply([
        say('assistant', 'Let me look at the tables.'),
        toolCall,
        say('assistant', 'There are 263 customers who never ordered.'),
      ])
    ).toBe('There are 263 customers who never ordered.');
  });

  it('joins every assistant message after the last tool call with a blank line', () => {
    expect(
      finalReply([
        say('assistant', 'Roughly 900, I think.'),
        toolCall,
        say('assistant', 'There are 263 customers who never ordered.'),
        say('assistant', 'Let me know if you want the list exported.'),
      ])
    ).toBe(
      'There are 263 customers who never ordered.\n\nLet me know if you want the list exported.'
    );
  });

  it('leaves out the user, system and empty messages between the ones it joins', () => {
    expect(
      finalReply([
        toolCall,
        say('assistant', 'There are 263.'),
        say('user', 'thanks!'),
        say('assistant', '  \n'),
        say('system', 'session ended'),
        say('assistant', 'Anything else?'),
      ])
    ).toBe('There are 263.\n\nAnything else?');
  });

  it('does not take an answer that came only before the last tool call', () => {
    expect(
      finalReply([
        toolCall,
        say('assistant', 'There are 263 customers who never ordered.'),
        toolCall,
        say('assistant', 'Let me know if you want the list exported.'),
      ])
    ).toBe('Let me know if you want the list exported.');
  });

  it('is undefined when the transcript ends on a tool call, whatever the agent said before it', () => {
    expect(
      finalReply([
        say('assistant', 'Let me look.'),
        toolCall,
        say('assistant', 'There are 263 customers who never ordered.'),
        toolCall,
      ])
    ).toBeUndefined();
  });

  it('joins every assistant message when the agent made no tool call', () => {
    expect(
      finalReply([say('assistant', 'First.'), say('assistant', 'Second.')])
    ).toBe('First.\n\nSecond.');
  });

  it('is undefined when a tool call comes after the only assistant message', () => {
    expect(
      finalReply([say('assistant', 'Done: 263.'), toolCall])
    ).toBeUndefined();
  });

  it('is undefined when only empty assistant messages follow the last tool call', () => {
    expect(
      finalReply([
        say('assistant', 'There are 263.'),
        toolCall,
        say('assistant', ''),
        say('assistant', '  \n'),
      ])
    ).toBeUndefined();
  });

  it('is undefined when only user and system messages follow the last tool call', () => {
    expect(
      finalReply([
        say('assistant', 'There are 263.'),
        toolCall,
        say('user', 'thanks!'),
        say('system', 'session ended'),
      ])
    ).toBeUndefined();
  });

  it('skips user and system messages after it', () => {
    expect(
      finalReply([
        say('assistant', 'Done: 263.'),
        say('user', 'thanks!'),
        say('system', 'session ended'),
      ])
    ).toBe('Done: 263.');
  });

  it('skips empty and whitespace-only assistant messages after it', () => {
    expect(
      finalReply([
        say('assistant', 'Done: 263.'),
        say('assistant', ''),
        say('assistant', '  \n'),
      ])
    ).toBe('Done: 263.');
  });

  it.each([
    ['an empty transcript', []],
    ['only a tool call', [toolCall]],
    [
      'only user and system messages',
      [say('user', 'How many?'), say('system', 'be brief')],
    ],
    ['only an empty assistant message', [say('assistant', '')]],
  ] satisfies Array<[string, TranscriptPart[]]>)(
    'is undefined for %s',
    (_label, transcript) => {
      expect(finalReply(transcript)).toBeUndefined();
    }
  );
});

describe('checkReplyGivesCount', () => {
  it.each([
    ['says it first', '263 customers have never placed an order.'],
    [
      'says it with the total',
      '263 of your 1,200 customers have never placed an order.',
    ],
    ['says it in a sentence', 'The exact number is 263.'],
    [
      'says it beside the customers who did order',
      '937 customers have ordered, so 263 have not.',
    ],
    [
      'says it in a list',
      '- customers: 1,200\n- never ordered: 263\n- ordered: 937',
    ],
    ['says it alone with a full stop', '263.'],
    ['says it in bold', 'You have **263** customers who never ordered.'],
    ['says it in brackets', 'Customers who never ordered (263) are ready.'],
    ['says it as an adjective', 'Here is a 263-customer win-back list.'],
  ])('passes a reply that %s', (_label, reply) => {
    expect(checkReplyGivesCount(reply)).toMatchObject({
      name: REPLY_CHECK,
      passed: true,
    });
  });

  it('passes a reply that gives the number after a long account of how it was found', () => {
    expect(
      checkReplyGivesCount(
        `${'I checked the tables first. '.repeat(300)}So 263 customers never ordered.`
      )
    ).toMatchObject({ passed: true });
  });

  it.each([
    ['zero', '0'],
    ['zero customers', 'No customers have never placed an order: 0.'],
    [
      'the customers who did order',
      '937 of your customers have placed an order.',
    ],
    ['a longer number ending in 263', '1263 customers have never ordered.'],
    ['a longer number starting with 263', '2630 customers have never ordered.'],
    ['a thousands number ending in 263', '1,263 customers have never ordered.'],
    [
      'a thousands number starting with 263',
      '263,000 customers have never ordered.',
    ],
    ['2,630', '2,630 customers have never ordered.'],
    ['263.5', 'About 263.5 customers have never ordered.'],
    ['a decimal', 'About 26.3% of customers never ordered.'],
    ['no number', 'Quite a few of your customers have never placed an order.'],
    ['the total only', 'You have 1,200 customers in total.'],
  ])('fails a reply that gives %s, quoting it', (_label, reply) => {
    const check = checkReplyGivesCount(reply);
    expect(check).toMatchObject({ name: REPLY_CHECK, passed: false });
    expect(check.notes).toContain(reply);
  });

  it.each([
    ['an empty reply', ''],
    ['a whitespace-only reply', '  \n'],
  ])('fails %s', (_label, reply) => {
    expect(checkReplyGivesCount(reply)).toMatchObject({
      name: REPLY_CHECK,
      passed: false,
    });
  });

  it('fails when the agent gave no reply at all', () => {
    const check = checkReplyGivesCount(undefined);
    expect(check).toMatchObject({ name: REPLY_CHECK, passed: false });
    expect(check.notes).toMatch(/\bno (?:final )?reply\b/i);
  });
});
