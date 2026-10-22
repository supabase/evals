// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-001-slow-query
import type { ToolCallRecord } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
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

const runsOf = (toolCalls: ToolCallRecord[]) => findInspectRuns(toolCalls);

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
    'supabase inspect db',
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
    [
      'an object whose output a terminal coloured',
      { stdout: '\u001b[32morders\u001b[0m' },
      true,
    ],
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
    ['a bare inspect db, which only prints help', 'supabase inspect db'],
    ['help for the command', 'supabase inspect db --help'],
    ['short help for the command', 'supabase inspect db outliers -h'],
  ])(
    'finds no run in %s even when its output names orders',
    (_label, command) => {
      expect(runsOf([inspect(command, OUTLIERS)])).toEqual([]);
    }
  );

  it('is empty when the agent ran nothing', () => {
    expect(findInspectRuns([])).toEqual([]);
  });
});

describe('findInspectRuns attribution', () => {
  const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  const ORDERS_ROW =
    ' select id, status from public.orders where customer_email = $1 |   200';
  const MIGRATION =
    'create table public.orders (\n  id bigint primary key,\n  customer_email text not null\n);';
  const RULES = '|RULE|STATUS|\n|-|-|\n|Unused indexes|PASS|\n';
  const REPORT_CSV =
    'query,calls\nselect id from public.orders where customer_email = $1,200\n';

  const credited = (toolCalls: ToolCallRecord[]) =>
    runsOf(toolCalls).map(({ namesOrders }) => namesOrders);
  const passes = (toolCalls: ToolCallRecord[]) =>
    checkInspectShowedOrders(runsOf(toolCalls)).passed;

  it.each([
    [
      'a psql fallback in the same call after a refused inspect',
      [
        call(
          `supabase inspect db outliers 2>&1 || psql "${DB_URL}" -c "select query, calls from extensions.pg_stat_statements order by total_exec_time desc limit 5"`,
          { result: `${NO_PROJECT_REF}\n${ORDERS_ROW}` }
        ),
      ],
    ],
    [
      'migrations cat-ed before an inspect that exited non-zero',
      [
        call('cat supabase/migrations/*.sql; supabase inspect db outliers', {
          error: `${MIGRATION}\n${NO_PROJECT_REF}`,
        }),
      ],
    ],
    [
      'a psql explain after an inspect whose output never named orders',
      [
        call(
          `supabase inspect db outliers --local | head -5; psql "$DB" -c "explain select * from public.orders where customer_email = 'x'"`,
          {
            result: `${UNRELATED_OUTLIERS}\nSeq Scan on orders  (cost=0.00..6500.00 rows=60 width=40)`,
          }
        ),
      ],
    ],
    [
      'an echo after the inspect',
      [
        call('supabase inspect db outliers --local; echo orders', {
          result: `${UNRELATED_OUTLIERS}\norders`,
        }),
      ],
    ],
    [
      'a db query after the inspect',
      [
        call(
          'supabase inspect db outliers --local && supabase db query "select * from orders limit 1"',
          { result: `${UNRELATED_OUTLIERS}\n${ORDERS_ROW}` }
        ),
      ],
    ],
    [
      'a migration read in a later call after a report with the default output directory',
      [
        call('supabase inspect report --local', { result: RULES }),
        call('cat supabase/migrations/20260102000000_x.sql', {
          result: MIGRATION,
        }),
      ],
    ],
    [
      'a grep of the seed in a later call',
      [
        inspect('supabase inspect db outliers --local', UNRELATED_OUTLIERS),
        call('grep orders supabase/seed.sql', {
          result: "insert into public.orders values ('a');",
        }),
      ],
    ],
    [
      'a read of a directory that only shares the output directory prefix',
      [
        call('supabase inspect report --local --output-dir /tmp/r', {
          result: RULES,
        }),
        call('cat /tmp/rx/2026-10-22/outliers.csv', { result: REPORT_CSV }),
      ],
    ],
    [
      'a read through a variable',
      [
        call('supabase inspect db outliers --local > /tmp/o.txt', {
          result: '',
        }),
        call('cat "$OUT"', { result: OUTLIERS }),
      ],
    ],
    [
      'a read that shares its call with another command',
      [
        call('supabase inspect db outliers --local > /tmp/o.txt', {
          result: '',
        }),
        call('cat /tmp/o.txt; echo done', { result: `${OUTLIERS}\ndone` }),
      ],
    ],
  ])('does not credit %s', (_label, toolCalls) => {
    expect(new Set(credited(toolCalls))).toEqual(new Set([false]));
    expect(passes(toolCalls)).toBe(false);
  });

  it.each([
    [
      'a pipe into head',
      'supabase inspect db outliers --local | head -40',
      OUTLIERS,
    ],
    [
      'a jq filter',
      `supabase inspect db table-stats --local -o json | jq '.[] | select(.Name | test("orders"))'`,
      TABLE_STATS_JSON,
    ],
    [
      'a chain of filters and a merged stderr',
      'supabase inspect db outliers --local 2>&1 | grep -i orders | sort | uniq -c | head',
      OUTLIERS,
    ],
    [
      'a report written and read back in one call',
      'supabase inspect report --local --output-dir /tmp/r && cat /tmp/r/*/outliers.csv',
      REPORT_CSV,
    ],
    [
      'two inspect reports in one call',
      'supabase inspect db outliers --local; supabase inspect db table-stats --local',
      OUTLIERS,
    ],
    [
      'a cd before the report',
      'cd /workspace && supabase inspect db outliers --local',
      OUTLIERS,
    ],
    [
      'a start before the report',
      'supabase start && supabase inspect db outliers --local',
      OUTLIERS,
    ],
    [
      'a version check, an export and a variable before the report',
      'supabase --version && export A=1 && DB=x && sleep 1 && supabase inspect db outliers --local',
      OUTLIERS,
    ],
    [
      'a bash wrapper',
      `bash -lc 'supabase inspect db outliers --local'`,
      OUTLIERS,
    ],
    [
      'a package runner',
      'npx supabase@beta inspect db calls --local | head -40',
      OUTLIERS,
    ],
    [
      'a prefixed environment',
      'SUPABASE_HOME=/tmp/h supabase inspect db outliers --local',
      OUTLIERS,
    ],
    [
      'an absolute binary path',
      '/usr/local/bin/supabase inspect db outliers --local',
      OUTLIERS,
    ],
  ])('credits %s', (_label, command, stdout) => {
    expect(new Set(credited([inspect(command, stdout)]))).toEqual(
      new Set([true])
    );
  });

  it('credits a report redirected to a file once a later call reads the file', () => {
    const runs = runsOf([
      call('supabase start'),
      call('supabase inspect db outliers --local > /tmp/outliers.txt 2>&1'),
      call('cat /tmp/outliers.txt', { result: OUTLIERS }),
    ]);
    expect(runs).toEqual([
      {
        commandIndex: 1,
        report: 'db outliers',
        errored: false,
        namesOrders: true,
        readInCall: 2,
      },
    ]);
    expect(checkInspectShowedOrders(runs).notes).toBe(
      'tool call 2: supabase inspect db outliers via tool call 3'
    );
  });

  it('credits a report written to a directory once a later call reads a file in it', () => {
    const runs = runsOf([
      call('supabase start'),
      call('supabase inspect report --local --output-dir /tmp/r', {
        result: RULES,
      }),
      call('cat /tmp/r/2026-10-22/outliers.csv', { result: REPORT_CSV }),
    ]);
    expect(runs).toEqual([
      {
        commandIndex: 1,
        report: 'report',
        errored: false,
        namesOrders: true,
        readInCall: 2,
      },
    ]);
  });

  it.each([
    [
      'the equals form of the output directory',
      'supabase inspect report --local --output-dir=/tmp/r',
      'head -5 /tmp/r/2026-10-22/outliers.csv',
    ],
    [
      'the current directory as the output directory',
      'supabase inspect report --local --output-dir .',
      'cat ./2026-10-22/outliers.csv',
    ],
    [
      'the default output directory',
      'supabase inspect report --local',
      'cat 2026-10-22/outliers.csv',
    ],
    [
      'a relative output directory',
      'supabase inspect report --local --output-dir reports',
      'cat ./reports/2026-10-22/outliers.csv',
    ],
    [
      'a combined redirect',
      'supabase inspect db outliers --local &> out.txt',
      'cat ./out.txt',
    ],
    [
      'an appending redirect',
      'supabase inspect db outliers --local >> /tmp/o.txt',
      'grep orders /tmp/o.txt',
    ],
    [
      'a tee',
      'supabase inspect db outliers --local | tee /tmp/o.txt > /dev/null',
      'tail -n 20 /tmp/o.txt',
    ],
    [
      'an input redirect',
      'supabase inspect db outliers --local > /tmp/o.txt',
      'jq . < /tmp/o.txt',
    ],
  ])('links a later read to the run for %s', (_label, run, read) => {
    const runs = runsOf([call(run), call(read, { result: REPORT_CSV })]);
    expect(runs.map(({ namesOrders }) => namesOrders)).toEqual([true]);
    expect(runs[0].readInCall).toBe(1);
  });

  it('credits every run whose output a read covers', () => {
    const runs = runsOf([
      call('supabase inspect report --local', { result: RULES }),
      call('supabase inspect report --local --output-dir .', { result: RULES }),
      call('cat 2026-10-22/outliers.csv', { result: REPORT_CSV }),
    ]);
    expect(runs.map(({ namesOrders }) => namesOrders)).toEqual([true, true]);
  });

  it('keeps the first read that credited a run', () => {
    const runs = runsOf([
      call('supabase inspect db outliers --local > /tmp/o.txt'),
      call('cat /tmp/o.txt', { result: OUTLIERS }),
      call('cat /tmp/o.txt', { result: OUTLIERS }),
    ]);
    expect(runs[0].readInCall).toBe(1);
  });

  it('marks the runs of a call whose output other commands share', () => {
    const runs = runsOf([
      call('supabase start'),
      call(
        `supabase inspect db outliers 2>&1 || psql "${DB_URL}" -c "select 1 from public.orders"`,
        { error: `${NO_PROJECT_REF}\n${ORDERS_ROW}` }
      ),
    ]);
    expect(runs).toEqual([
      {
        commandIndex: 1,
        report: 'db outliers',
        errored: true,
        namesOrders: false,
        sharedOutput: true,
      },
    ]);
    expect(checkInspectShowedOrders(runs).notes).toContain(
      'tool call 2: supabase inspect db outliers (errored; output shared with other commands)'
    );
  });

  it('does not mark a call that named no table, however many commands it ran', () => {
    expect(
      runsOf([
        call('supabase inspect db outliers --local; echo done', {
          result: `${UNRELATED_OUTLIERS}\ndone`,
        }),
      ])[0].sharedOutput
    ).toBeUndefined();
  });
});

describe('findInspectRuns file operands', () => {
  const credited = (command: string, stdout: string) =>
    runsOf([inspect(command, stdout)]).map(({ namesOrders }) => namesOrders);

  it.each([
    [
      'a recursive grep of the project',
      'supabase inspect db outliers --local; grep -r orders supabase',
    ],
    [
      'a cat of a bare file name',
      'supabase inspect db outliers --local; cat Makefile',
    ],
    [
      'a grep of a bare directory name',
      'supabase inspect db outliers --local; grep orders supabase',
    ],
    [
      'a grep whose pattern comes from -e and whose file is named',
      'supabase inspect db outliers --local; grep -e orders supabase/seed.sql',
    ],
    [
      'a grep whose pattern is attached to -e',
      'supabase inspect db outliers --local; grep -eorders supabase/seed.sql',
    ],
    [
      'a sed over a file',
      "supabase inspect db outliers --local; sed -n '1,5p' seed.sql",
    ],
    [
      'a numeric pattern that leaves the file operand',
      'supabase inspect db outliers --local; grep 5 supabase',
    ],
  ])('does not credit %s', (_label, command) => {
    expect(credited(command, OUTLIERS)).toEqual([false]);
  });

  it.each([
    ['a case-insensitive grep', 'grep -i orders', OUTLIERS],
    ['a sed print range', "sed -n '1,40p'", OUTLIERS],
    ['a sed substitution containing slashes', "sed 's/a/b/'", OUTLIERS],
    ['head with a count', 'head -n 40', OUTLIERS],
    ['tail from a line', 'tail -n +2', OUTLIERS],
    ['a jq field filter', "jq -r '.[].Name'", TABLE_STATS_JSON],
    ['jq with clustered flags', "jq -er '.[].Name'", TABLE_STATS_JSON],
    [
      'a jq variable',
      `jq --arg n orders '.[] | select(.Name == $n)'`,
      TABLE_STATS_JSON,
    ],
    ['a grep pattern from -e', 'grep -e orders', OUTLIERS],
    [
      'a grep with several -e patterns',
      'grep -e orders -e customers',
      OUTLIERS,
    ],
    ['a grep with a match limit', 'grep -m 5 -i orders', OUTLIERS],
    ['an awk field separator', `awk -F '|' '{print $2}'`, OUTLIERS],
    ['cut with attached flag values', 'cut -d, -f1', OUTLIERS],
    ['tr with arguments that are not files', "tr '/' ' '", OUTLIERS],
    ['wc and column', 'column -t', OUTLIERS],
  ])('credits a pipe into %s', (_label, filter, stdout) => {
    const command = filter.startsWith('jq')
      ? `supabase inspect db table-stats --local -o json | ${filter}`
      : `supabase inspect db outliers --local | ${filter}`;
    expect(credited(command, stdout)).toEqual([true]);
  });

  it('counts the value of a separated flag as a file operand, so cut -d "," credits nothing', () => {
    expect(
      credited(
        `supabase inspect db outliers --local --output-format csv | cut -d ',' -f 1`,
        OUTLIERS
      )
    ).toEqual([false]);
  });

  it.each([
    'supabase stack start',
    'supabase stack stop',
    'supabase stack status',
    'supabase stack list',
  ])('credits a run after %s in the same call', (quiet) => {
    expect(
      credited(`${quiet} && supabase inspect db outliers --local`, OUTLIERS)
    ).toEqual([true]);
  });

  it('links a later read of a file a tee wrote under a bare name', () => {
    const runs = runsOf([
      call('supabase inspect db outliers --local | tee out.txt > /dev/null'),
      call('cat out.txt', { result: OUTLIERS }),
    ]);
    expect(runs.map(({ namesOrders }) => namesOrders)).toEqual([true]);
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

  it('says which later tool call read the output that named orders', () => {
    const check = checkInspectShowedOrders([run({ readInCall: 3 })]);
    expect(check).toMatchObject({ passed: true });
    expect(check.notes).toBe(
      'tool call 2: supabase inspect db outliers via tool call 4'
    );
  });

  it('says a failing run shared its output with other commands', () => {
    const check = checkInspectShowedOrders([
      run({ namesOrders: false, errored: true, sharedOutput: true }),
      run({
        commandIndex: 2,
        report: 'db calls',
        namesOrders: false,
        sharedOutput: true,
      }),
    ]);
    expect(check.passed).toBe(false);
    expect(check.notes).toContain(
      'tool call 2: supabase inspect db outliers (errored; output shared with other commands)'
    );
    expect(check.notes).toContain(
      'tool call 3: supabase inspect db calls (output shared with other commands)'
    );
  });

  it('marks nothing as errored when no report errored', () => {
    const check = checkInspectShowedOrders([
      run({ report: 'db calls', namesOrders: false }),
    ]);
    expect(check.passed).toBe(false);
    expect(check.notes).not.toMatch(/errored/);
  });
});
