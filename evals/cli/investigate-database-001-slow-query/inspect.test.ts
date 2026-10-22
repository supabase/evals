// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-001-slow-query
import type { ToolCallRecord } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  findSupabaseInvocations,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { extractCommandEntries } from '../lib/detours.js';
import {
  checkInspectShowedOrders,
  findInspectRuns,
  INSPECT_CHECK_NAME,
  type InspectRun,
  inspectReport,
} from './inspect.js';

const OUTLIERS = `|QUERY|EXECUTION TIME|PROPORTION OF EXEC TIME|NUMBER CALLS|SYNC IO TIME|
|-|-|-|-|-|
|\`select id, status, total_cents, created_at from public.orders where customer_email = $1 order by created_at desc limit $2\`|00:00:02.810|71.4%|200|00:00:00|
|\`insert into public.orders (customer_email, status, total_cents, created_at) select $1 || (n % $2) || $3, (array[$4, $5, $6, $7])[$8 + n % $9], $10 + (n * $11) % $12, timestamptz $13 + n * interval $14 from generate_series($15, $16) as n\`|00:00:00.940|23.9%|1|00:00:00|
`;

const TABLE_STATS_JSON = `[{"name":"public.orders","table_size":"21 MB","index_size":"6600 kB","estimated_row_count":300000,"seq_scans":200}]`;

const UNRELATED_OUTLIERS = `|QUERY|EXECUTION TIME|PROPORTION OF EXEC TIME|NUMBER CALLS|SYNC IO TIME|
|-|-|-|-|-|
|\`select name from pg_timezone_names\`|00:00:00.120|88.0%|3|00:00:00|
`;

const NO_PROJECT_REF = 'Cannot find project ref. Have you run supabase link?';

function call(
  command: string,
  output: { result?: unknown; error?: string } = {}
): ToolCallRecord {
  return {
    tool: { kind: 'other', toolName: 'shell' },
    body: { command },
    command,
    result: 'result' in output ? output.result : '',
    ...(output.error === undefined ? {} : { error: output.error }),
    ts: 0,
  };
}

const fileWrite = (result = ''): ToolCallRecord => ({
  tool: { kind: 'other', toolName: 'file_write' },
  body: { path: 'supabase/migrations/20260102000000_idx.sql' },
  result,
  ts: 0,
});

const invocationsOf = (toolCalls: ToolCallRecord[]) =>
  findSupabaseInvocations(extractCommandEntries(toolCalls));

const runsOf = (toolCalls: ToolCallRecord[]) =>
  findInspectRuns(toolCalls, invocationsOf(toolCalls));

const inspect = (command: string, stdout: string) =>
  call(command, { result: stdout });

describe('inspectReport', () => {
  const reportOf = (command: string) => {
    const [invocation] = findSupabaseInvocations([command]);
    return inspectReport(invocation);
  };

  it.each([
    ['supabase inspect db outliers --local', 'db outliers'],
    ['supabase inspect db outliers', 'db outliers'],
    ['supabase inspect db outliers --linked', 'db outliers'],
    ['supabase inspect db table-stats --local -o json', 'db table-stats'],
    ['supabase inspect db calls --local --output-format json', 'db calls'],
    ['supabase inspect db seq-scans --local', 'db seq-scans'],
    ['supabase inspect db index-usage --local', 'db index-usage'],
    ['supabase --workdir /ws inspect db outliers --local', 'db outliers'],
    ['npx supabase@beta inspect db calls --local | head -40', 'db calls'],
    [
      'npx --yes supabase@2.120.0 inspect db table-stats --local',
      'db table-stats',
    ],
    ['cd /ws && supabase inspect db outliers --local', 'db outliers'],
    ['supabase inspect report --local', 'report'],
    ['supabase inspect db', 'db'],
  ])('reads %j as the report %j', (command, expected) => {
    expect(reportOf(command)).toBe(expected);
  });

  it('leaves the connection string out of the report', () => {
    expect(
      reportOf(
        'supabase inspect db outliers --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres'
      )
    ).toBe('db outliers');
  });

  it('leaves the output directory out of the report', () => {
    expect(
      reportOf('supabase inspect report --local --output-dir /tmp/r')
    ).toBe('report');
  });

  it.each([
    'supabase start',
    'supabase db reset',
    'supabase migration up',
    'supabase status',
    'supabase db query --local "select 1"',
    'supabase db query --local "select * from pg_stat_statements"',
  ])('is undefined for %j', (command) => {
    expect(reportOf(command)).toBeUndefined();
  });
});

describe('findInspectRuns', () => {
  it('maps an inspect invocation to its own tool call and reads the table it printed', () => {
    expect(
      runsOf([
        call('supabase start'),
        inspect('supabase inspect db outliers --local', OUTLIERS),
      ])
    ).toEqual([
      {
        commandIndex: 1,
        report: 'db outliers',
        errored: false,
        namesOrders: true,
      },
    ]);
  });

  it('reads the output of its own call when an earlier tool call ran no command', () => {
    const skipped = [
      fileWrite('public.orders'),
      inspect('supabase inspect db outliers --local', UNRELATED_OUTLIERS),
    ];
    expect(runsOf(skipped)).toEqual([
      {
        commandIndex: 0,
        report: 'db outliers',
        errored: false,
        namesOrders: false,
      },
    ]);
    const showing = [
      fileWrite(),
      call('echo done', { result: 'unrelated' }),
      inspect('supabase inspect db table-stats --local', TABLE_STATS_JSON),
    ];
    expect(runsOf(showing)).toEqual([
      {
        commandIndex: 1,
        report: 'db table-stats',
        errored: false,
        namesOrders: true,
      },
    ]);
  });

  it('does not count a report that never mentions orders', () => {
    expect(
      runsOf([
        inspect('supabase inspect db outliers --local', UNRELATED_OUTLIERS),
      ])
    ).toMatchObject([{ report: 'db outliers', namesOrders: false }]);
  });

  it('marks a call that errored, whatever its error says', () => {
    expect(
      runsOf([call('supabase inspect db outliers', { error: NO_PROJECT_REF })])
    ).toEqual([
      {
        commandIndex: 0,
        report: 'db outliers',
        errored: true,
        namesOrders: false,
      },
    ]);
  });

  it('reads orders out of an error, as a command that exits non-zero keeps its output there', () => {
    expect(
      runsOf([
        call('supabase inspect db outliers --local | head -40', {
          error: `exit code 141\n${OUTLIERS}`,
        }),
      ])
    ).toEqual([
      {
        commandIndex: 0,
        report: 'db outliers',
        errored: true,
        namesOrders: true,
      },
    ]);
  });

  it.each([
    ['a string result', OUTLIERS, true],
    ['an object result', { stdout: OUTLIERS, exitCode: 0 }, true],
    [
      'an object whose orders sits at the start of a line',
      { stdout: 'NAME\norders\n' },
      true,
    ],
    ['an array of lines', ['NAME', 'public.orders'], true],
    ['a null result', null, false],
    ['an undefined result', undefined, false],
    ['an object without it', { stdout: UNRELATED_OUTLIERS }, false],
  ])('reads %s', (_label, result, expected) => {
    expect(
      runsOf([call('supabase inspect db outliers --local', { result })])[0]
        .namesOrders
    ).toBe(expected);
  });

  it.each([
    ['a qualified name', '| public.orders | 21 MB |', true],
    ['a bare name', 'orders  300000', true],
    ['a quoted name', '"orders"', true],
    ['a name in a JSON field', TABLE_STATS_JSON, true],
    ['a name closing a sentence', 'Sequential scans on orders.', true],
    [
      'a table that merely starts with the name',
      'public.orders_archive',
      false,
    ],
    ['a table that merely ends with the name', 'public.preorders', false],
    ['a column that holds the name', 'customer_orders', false],
    ['a plural of something else', 'reorders 12', false],
    ['nothing', '', false],
  ])('matches orders as a whole word in %s', (_label, stdout, expected) => {
    expect(
      runsOf([inspect('supabase inspect db table-stats --local', stdout)])[0]
        .namesOrders
    ).toBe(expected);
  });

  it('reads a name a terminal coloured in pieces', () => {
    const coloured =
      '\u001b[1mpublic.\u001b[22m\u001b[32morders\u001b[0m  \u001b[33m300000\u001b[0m';
    expect(
      runsOf([inspect('supabase inspect db table-stats --local', coloured)])[0]
        .namesOrders
    ).toBe(true);
  });

  it('reads the output of inspect report cat-ed in the same call', () => {
    const csv =
      'query,calls\nselect id from public.orders where customer_email = $1,200\n';
    const runs = runsOf([
      inspect(
        'supabase inspect report --local --output-dir /tmp/r && cat /tmp/r/*/outliers.csv',
        `Wrote 12 reports to /tmp/r/2026-01-05\n${csv}`
      ),
    ]);
    expect(runs).toEqual([
      { commandIndex: 0, report: 'report', errored: false, namesOrders: true },
    ]);
  });

  it('does not count an inspect report whose rules table never names orders', () => {
    const rules = '|RULE|STATUS|\n|-|-|\n|Unused indexes|PASS|\n';
    expect(
      runsOf([
        inspect('supabase inspect report --local --output-dir /tmp/r', rules),
      ])[0].namesOrders
    ).toBe(false);
  });

  it.each([
    [
      'a package runner with a pinned channel and a pipe',
      'npx supabase@beta inspect db calls --local | head -40',
      'db calls',
    ],
    [
      'a deprecated alias',
      'supabase inspect db seq-scans --local',
      'db seq-scans',
    ],
    [
      'a connection string',
      'supabase inspect db outliers --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres',
      'db outliers',
    ],
    [
      'json output',
      'supabase inspect db table-stats --local --output-format json',
      'db table-stats',
    ],
  ])('counts %s', (_label, command, report) => {
    expect(runsOf([inspect(command, 'public.orders  21 MB')])).toEqual([
      { commandIndex: 0, report, errored: false, namesOrders: true },
    ]);
  });

  it('lists every inspect invocation in order', () => {
    const runs = runsOf([
      call('supabase inspect db outliers', { error: NO_PROJECT_REF }),
      inspect('supabase inspect db outliers --local', OUTLIERS),
      call('supabase start'),
      inspect('supabase inspect db calls --local', UNRELATED_OUTLIERS),
    ]);
    expect(
      runs.map(({ commandIndex, report }) => [commandIndex, report])
    ).toEqual([
      [0, 'db outliers'],
      [1, 'db outliers'],
      [3, 'db calls'],
    ]);
  });

  it('lists each inspect invocation of one tool call, all reading that call output', () => {
    const runs = runsOf([
      inspect(
        'supabase inspect db outliers --local && supabase inspect db calls --local',
        OUTLIERS
      ),
    ]);
    expect(
      runs.map(({ commandIndex, report }) => [commandIndex, report])
    ).toEqual([
      [0, 'db outliers'],
      [0, 'db calls'],
    ]);
  });

  it.each([
    [
      'psql against pg_stat_statements',
      `psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' -XtAc "select query, calls from pg_stat_statements order by total_exec_time desc limit 5"`,
    ],
    [
      'supabase db query against pg_stat_statements',
      'supabase db query --local "select query, calls from pg_stat_statements order by calls desc"',
    ],
    ['an echo that names the command', 'echo "supabase inspect db outliers"'],
    ['a comment that names the command', '# supabase inspect db outliers'],
    [
      'a commit message that names the command',
      'git commit -m "run supabase inspect db outliers"',
    ],
    ['help for the command', 'supabase inspect db --help'],
    ['short help for the command', 'supabase inspect db outliers -h'],
  ])(
    'finds no run in %s even when its output names orders',
    (_label, command) => {
      expect(runsOf([inspect(command, OUTLIERS)])).toEqual([]);
    }
  );

  it('does not let a help invocation pass the check even when handed one directly', () => {
    const help: SupabaseInvocation = {
      commandIndex: 0,
      argv: ['supabase', 'inspect', 'db', '--help'],
    };
    const calls = [inspect('supabase inspect db --help', OUTLIERS)];
    expect(
      checkInspectShowedOrders(findInspectRuns(calls, [help])).passed
    ).toBe(false);
  });

  it('does not throw for an invocation that points past the tool calls', () => {
    const stray: SupabaseInvocation = {
      commandIndex: 5,
      argv: ['supabase', 'inspect', 'db', 'outliers', '--local'],
    };
    expect(() => findInspectRuns([], [stray])).not.toThrow();
  });

  it('is empty when the agent ran nothing', () => {
    expect(findInspectRuns([], [])).toEqual([]);
  });
});

const run = (overrides: Partial<InspectRun> = {}): InspectRun => ({
  commandIndex: 1,
  report: 'db outliers',
  errored: false,
  namesOrders: true,
  ...overrides,
});

describe('checkInspectShowedOrders', () => {
  it('passes when a report named orders and says which tool call ran it', () => {
    const check = checkInspectShowedOrders([run()]);
    expect(check).toMatchObject({ name: INSPECT_CHECK_NAME, passed: true });
    expect(check.notes).toContain('tool call 2: supabase inspect db outliers');
  });

  it('names the first report that showed orders when several ran', () => {
    const check = checkInspectShowedOrders([
      run({ commandIndex: 0, report: 'db calls', namesOrders: false }),
      run({ commandIndex: 1, report: 'db table-stats' }),
      run({ commandIndex: 2, report: 'db outliers' }),
    ]);
    expect(check.passed).toBe(true);
    expect(check.notes).toContain(
      'tool call 2: supabase inspect db table-stats'
    );
  });

  it('passes a run that errored after printing orders', () => {
    expect(checkInspectShowedOrders([run({ errored: true })]).passed).toBe(
      true
    );
  });

  it('passes when one run errored and another showed orders', () => {
    const check = checkInspectShowedOrders([
      run({ commandIndex: 0, errored: true, namesOrders: false }),
      run({ commandIndex: 1, report: 'db table-stats' }),
    ]);
    expect(check.passed).toBe(true);
  });

  it('fails when no inspect report ran', () => {
    expect(checkInspectShowedOrders([])).toEqual({
      name: INSPECT_CHECK_NAME,
      passed: false,
      notes: 'no supabase inspect report ran',
    });
  });

  it('fails when the reports that ran never named orders, listing them and marking the errored ones', () => {
    const check = checkInspectShowedOrders([
      run({ commandIndex: 0, errored: true, namesOrders: false }),
      run({ commandIndex: 1, report: 'db calls', namesOrders: false }),
    ]);
    expect(check).toMatchObject({ name: INSPECT_CHECK_NAME, passed: false });
    expect(check.notes).toContain('db outliers');
    expect(check.notes).toContain('db calls');
    expect(check.notes).toMatch(/errored/);
    expect(check.notes).toMatch(/orders/);
  });

  it('marks nothing as errored when no report errored', () => {
    const check = checkInspectShowedOrders([
      run({ report: 'db calls', namesOrders: false }),
    ]);
    expect(check.passed).toBe(false);
    expect(check.notes).not.toMatch(/errored/);
  });
});
