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
  formatAnswerSourceJudgeInput,
  gateAnswerSource,
  isDbQueryInvocation,
  REPLY_CHECK,
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

const verdicts = (command: string) =>
  findSupabaseInvocations([command]).map(isDbQueryInvocation);

const run = (overrides: Partial<DbQueryRun> = {}): DbQueryRun => ({
  commandIndex: 0,
  command: 'supabase db query "select 1"',
  output: '{"rows":[{"?column?":1}]}',
  errored: false,
  showsAnswer: false,
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

describe('gateAnswerSource', () => {
  it('fails when no db query ran', () => {
    expect(gateAnswerSource([])).toEqual({
      name: ANSWER_SOURCE_CHECK,
      passed: false,
      notes: 'no supabase db query ran',
    });
  });

  it('passes naming the tool call of a run that showed 263', () => {
    const check = gateAnswerSource([
      run({ commandIndex: 2, showsAnswer: true }),
    ]);
    expect(check).toMatchObject({ name: ANSWER_SOURCE_CHECK, passed: true });
    expect(check?.notes).toContain('tool call 3');
  });

  it('names the run that showed 263 among runs that did not', () => {
    const check = gateAnswerSource([
      run({ commandIndex: 0 }),
      run({ commandIndex: 1, errored: true }),
      run({ commandIndex: 4, showsAnswer: true }),
    ]);
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
        ])
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
      ])
    );
    expect(check?.passed).toBe(true);
    expect(check?.notes).toContain('tool call 2');
    expect(check?.notes).not.toContain('tool call 1');
  });

  it('leaves the verdict to the judge when no run showed 263', () => {
    expect(gateAnswerSource([run()])).toBeUndefined();
    expect(
      gateAnswerSource([
        run({ commandIndex: 0 }),
        run({ commandIndex: 3, errored: true }),
      ])
    ).toBeUndefined();
  });
});

describe('formatAnswerSourceJudgeInput', () => {
  it('gives each run its 1-based tool call number, its command and its output', () => {
    const input = formatAnswerSourceJudgeInput([
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
    ]);
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
    const input = formatAnswerSourceJudgeInput([
      run({ commandIndex: 1, output: 'first-output' }),
      run({ commandIndex: 5, output: 'second-output' }),
    ]);
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
    const input = formatAnswerSourceJudgeInput([run({ command, output })]);
    expect(input).toContain(command);
    expect(input).toContain(output);
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

  it('is the last assistant message', () => {
    expect(
      finalReply([
        say('assistant', 'Let me look at the tables.'),
        toolCall,
        say('assistant', 'There are 263 customers who never ordered.'),
      ])
    ).toBe('There are 263 customers who never ordered.');
  });

  it('is not replaced by a tool call that came after it', () => {
    expect(finalReply([say('assistant', 'Done: 263.'), toolCall])).toBe(
      'Done: 263.'
    );
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
