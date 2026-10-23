// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-001-slow-query
import type { ToolCallRecord } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  findSupabaseInvocations,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { extractCommandEntries } from '../lib/detours.js';
import {
  findInspectEvidence,
  findInspectRuns,
  formatInspectJudgeInput,
  gateInspectEvidence,
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
  output: { result?: unknown; error?: string; cwd?: string } = {}
): ToolCallRecord {
  return {
    tool: { kind: 'other', toolName: 'shell' },
    body: { command },
    command,
    ...(output.cwd === undefined ? {} : { cwd: output.cwd }),
    result: 'result' in output ? output.result : '',
    ...(output.error === undefined ? {} : { error: output.error }),
    ts: 0,
  };
}

const LATER = 'later call naming an output path';

const RULES =
  'Reports saved to /workspace/2026-10-22\n|RULE|STATUS|MATCHES|\n|-|-|-|\n|No unused indexes|✔||\n';

const bashLc = (script: string) =>
  `/bin/bash -lc ${
    script.includes("'")
      ? `"${script.replace(/([\\"])/g, '\\$1')}"`
      : `'${script}'`
  }`;

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

const evidenceOf = (toolCalls: ToolCallRecord[]) =>
  findInspectEvidence(toolCalls, runsOf(toolCalls));

const indexesOf = (toolCalls: ToolCallRecord[]) =>
  evidenceOf(toolCalls).map(({ commandIndex }) => commandIndex);

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
  it('maps an inspect invocation to its own tool call', () => {
    expect(
      runsOf([
        call('supabase start'),
        inspect('supabase inspect db outliers --local', OUTLIERS),
      ])
    ).toEqual([{ commandIndex: 1, report: 'db outliers', errored: false }]);
  });

  it('aligns with the commands when an earlier tool call ran none', () => {
    expect(
      runsOf([
        fileWrite(),
        call('echo done'),
        inspect('supabase inspect db table-stats --local', TABLE_STATS_JSON),
      ])
    ).toEqual([{ commandIndex: 1, report: 'db table-stats', errored: false }]);
  });

  it('marks a call that errored, whatever its error says', () => {
    expect(
      runsOf([call('supabase inspect db outliers', { error: NO_PROJECT_REF })])
    ).toEqual([{ commandIndex: 0, report: 'db outliers', errored: true }]);
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
    [
      'a report written to a directory',
      'supabase inspect report --local --output-dir /tmp/r',
      'report',
    ],
  ])('counts %s', (_label, command, report) => {
    expect(runsOf([inspect(command, 'public.orders  21 MB')])).toEqual([
      { commandIndex: 0, report, errored: false },
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

  it('lists each inspect invocation of one tool call', () => {
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
  ])('finds no run in %s', (_label, command) => {
    expect(runsOf([inspect(command, OUTLIERS)])).toEqual([]);
  });

  it('ignores a help invocation handed to it directly', () => {
    const help: SupabaseInvocation = {
      commandIndex: 0,
      argv: ['supabase', 'inspect', 'db', '--help'],
    };
    expect(
      findInspectRuns([inspect('supabase inspect db --help', OUTLIERS)], [help])
    ).toEqual([]);
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

describe('findInspectEvidence', () => {
  it('takes a parsed inspect call as a candidate with its command and output', () => {
    const command = 'supabase inspect db outliers --local';
    expect(
      evidenceOf([call('supabase start'), inspect(command, OUTLIERS)])
    ).toEqual([
      {
        commandIndex: 1,
        kind: 'candidate',
        command,
        output: `${OUTLIERS}\n`,
        namesOrders: true,
      },
    ]);
  });

  it.each([
    [
      'a tr -d with a quote before the report',
      `DB_URL=$(supabase status -o env | grep '^DB_URL=' | cut -d= -f2- | tr -d '"'); supabase inspect db outliers --db-url "$DB_URL"`,
    ],
    [
      'a timeout around a bash wrapper',
      `timeout 120 bash -lc 'supabase inspect db outliers --local'`,
    ],
    [
      'a brace group',
      '{ supabase inspect db outliers --local; supabase inspect db calls --local; } 2>&1 | head -80',
    ],
    ['a help invocation', 'supabase inspect db --help'],
    ['an echo of the command', 'echo "supabase inspect db outliers"'],
  ])(
    'keeps a call with %s even when parsing finds no run',
    (_label, command) => {
      const calls = [inspect(command, OUTLIERS)];
      expect(findInspectEvidence(calls, [])).toMatchObject([
        { commandIndex: 0, kind: 'candidate', command },
      ]);
    }
  );

  it.each([
    'supabase status',
    'supabase db query --local "select * from orders limit 1"',
    `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "select * from orders"`,
    'cat supabase/seed.sql',
    'rg -n customer_email',
  ])('leaves out an unrelated call %j', (command) => {
    expect(evidenceOf([inspect(command, OUTLIERS)])).toEqual([]);
  });

  it('numbers evidence by tool call among the commands, in call order', () => {
    expect(
      indexesOf([
        fileWrite(),
        call('supabase start'),
        inspect('supabase inspect db outliers --local', OUTLIERS),
        call('echo done'),
        inspect('supabase inspect db calls --local', OUTLIERS),
      ])
    ).toEqual([1, 3]);
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
      evidenceOf([call('supabase inspect db outliers --local', { result })])[0]
        .namesOrders
    ).toBe(expected);
  });

  it('reads orders out of an error, as a command that exits non-zero keeps its output there', () => {
    const [evidence] = evidenceOf([
      call('supabase inspect db outliers --local | head -40', {
        error: `exit code 141\n${OUTLIERS}`,
      }),
    ]);
    expect(evidence.namesOrders).toBe(true);
    expect(evidence.output).toContain('exit code 141');
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
      evidenceOf([
        inspect('supabase inspect db table-stats --local', stdout),
      ])[0].namesOrders
    ).toBe(expected);
  });

  it('reads a name a terminal coloured in pieces', () => {
    const coloured =
      '\u001b[1mpublic.\u001b[22m\u001b[32morders\u001b[0m  \u001b[33m300000\u001b[0m';
    expect(
      evidenceOf([
        inspect('supabase inspect db table-stats --local', coloured),
      ])[0].namesOrders
    ).toBe(true);
  });

  describe('later calls', () => {
    const csv =
      'query,calls\nselect id from public.orders where customer_email = $1,200\n';

    it('includes a later call that reads a file the report was redirected to', () => {
      const evidence = evidenceOf([
        call('supabase start'),
        call('supabase inspect db outliers --local > /tmp/outliers.txt 2>&1'),
        call('cat /tmp/outliers.txt', { result: OUTLIERS }),
      ]);
      expect(
        evidence.map(({ commandIndex, kind, namesOrders }) => [
          commandIndex,
          kind,
          namesOrders,
        ])
      ).toEqual([
        [1, 'candidate', false],
        [2, LATER, true],
      ]);
    });

    it('includes a later call that reads a file in the report output directory', () => {
      expect(
        indexesOf([
          call('supabase start'),
          call('supabase inspect report --local --output-dir /tmp/r', {
            result: '|RULE|STATUS|\n|-|-|\n|Unused indexes|PASS|\n',
          }),
          call('cat /tmp/r/2026-10-22/outliers.csv', { result: csv }),
        ])
      ).toEqual([1, 2]);
    });

    it.each([
      [
        'the equals form of the output directory',
        'supabase inspect report --local --output-dir=/tmp/r',
        'head -5 /tmp/r/2026-10-22/outliers.csv',
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
        'a quoted redirect target',
        `supabase inspect db outliers --local > "/tmp/o.txt"`,
        'cat /tmp/o.txt',
      ],
      [
        'a tee',
        'supabase inspect db outliers --local | tee -a /tmp/o.txt',
        'tail -n 20 /tmp/o.txt',
      ],
      [
        'a redirect after a merged stderr',
        'supabase inspect db outliers --local 2>&1 > /tmp/o.txt',
        'cat /tmp/o.txt',
      ],
    ])('follows %s', (_label, run, read) => {
      expect(indexesOf([call(run), call(read, { result: csv })])).toEqual([
        0, 1,
      ]);
    });

    it.each([
      [
        'the default output directory',
        'supabase inspect report --local',
        'cat 2026-10-22/outliers.csv',
      ],
      [
        'the current directory as the output directory',
        'supabase inspect report --local --output-dir .',
        'cat ./2026-10-22/outliers.csv',
      ],
    ])('follows a dated folder under %s', (_label, run, read) => {
      expect(indexesOf([call(run), call(read, { result: csv })])).toEqual([
        0, 1,
      ]);
    });

    it.each([
      [
        'a file the report did not write',
        'supabase inspect report --local --output-dir /tmp/r',
        'cat /tmp/other.txt',
      ],
      [
        'a directory sharing no path with the output',
        'supabase inspect db outliers --local > /tmp/o.txt',
        'cat supabase/migrations/20260102000000_x.sql',
      ],
      [
        'a migration after a report with the default output directory',
        'supabase inspect report --local',
        'cat supabase/migrations/20260102000000_x.sql',
      ],
      [
        'the null device and a merged stderr',
        'supabase inspect db outliers --local 2>&1 > /dev/null',
        'ls /dev/null',
      ],
    ])('leaves out a later call reading %s', (_label, run, read) => {
      expect(indexesOf([call(run), call(read, { result: csv })])).toEqual([0]);
    });

    it('leaves out a call before the report that names the same file', () => {
      expect(
        indexesOf([
          call('cat /tmp/o.txt', { result: csv }),
          call('supabase inspect db outliers --local > /tmp/o.txt'),
        ])
      ).toEqual([1]);
    });

    it('includes a later call that only mentions the path, and leaves the verdict to the judge', () => {
      const evidence = evidenceOf([
        call('supabase inspect db outliers --local > /tmp/o.txt'),
        call(
          `psql "$DB" -c "explain select * from orders" > /tmp/o.txt; cat /tmp/o.txt`,
          { result: 'Seq Scan on orders' }
        ),
      ]);
      expect(evidence.map(({ kind }) => kind)).toEqual(['candidate', LATER]);
    });

    it('lists a call once when it both ran inspect and mentions an earlier path', () => {
      const evidence = evidenceOf([
        call('supabase inspect db outliers --local > /tmp/o.txt'),
        call('supabase inspect db calls --local | tee -a /tmp/o.txt'),
      ]);
      expect(evidence.map(({ kind }) => kind)).toEqual([
        'candidate',
        'candidate',
      ]);
    });

    describe('after an inspect report', () => {
      const report = () =>
        call('supabase inspect report --local', { result: RULES });

      it.each([
        [
          'a cd into the dated folder',
          'cd 2026-10-22 && head -n 5 outliers.csv calls.csv',
        ],
        [
          'a grep of the dated folder',
          'grep -rn customer_email /workspace/2026-10-22',
        ],
        [
          'a find -exec over the dated folder',
          "find 2026-10-22 -name '*.csv' -exec head -3 {} +",
        ],
        ['a glob over the dated folders', 'head -n 5 */outliers.csv'],
        [
          'a python glob',
          `python3 -c "import glob; [print(open(p).read()) for p in glob.glob('*/outliers.csv')]"`,
        ],
        ['a find by file name', 'cat $(find . -name outliers.csv | head -1)'],
        ['a dated folder with a slash', 'head -n 5 2026-10-22/outliers.csv'],
      ])('includes a call using %s', (_label, read) => {
        expect(indexesOf([report(), call(read, { result: csv })])).toEqual([
          0, 1,
        ]);
      });

      it.each([
        'bloat',
        'blocking',
        'calls',
        'db_stats',
        'index_stats',
        'locks',
        'long_running_queries',
        'outliers',
        'replication_slots',
        'role_stats',
        'table_stats',
        'traffic_profile',
        'unused_indexes',
        'vacuum_stats',
      ])('includes a call naming the %s report file', (name) => {
        expect(
          indexesOf([report(), call(`cat ${name}.csv`, { result: csv })])
        ).toEqual([0, 1]);
      });

      it('includes a call run in the output directory through its working directory', () => {
        expect(
          indexesOf([
            call('supabase inspect report --local --output-dir /tmp/r'),
            call('head -5 outliers.csv', {
              cwd: '/tmp/r/2026-10-22',
              result: csv,
            }),
            call('ls', { cwd: '/tmp/r/results', result: csv }),
          ])
        ).toEqual([0, 1, 2]);
      });

      it('leaves out a call that names no report file or dated folder', () => {
        expect(
          indexesOf([
            report(),
            call('cat supabase/seed.sql', { cwd: '/workspace', result: csv }),
            call('head -3 other.csv', { result: csv }),
          ])
        ).toEqual([0]);
      });

      it('does not follow report file names after a run of another report', () => {
        expect(
          indexesOf([
            call('supabase inspect db outliers --local'),
            call('head -5 outliers.csv', { result: csv }),
          ])
        ).toEqual([0]);
      });

      it.each([
        ['a glob one folder down', 'cat */*.csv'],
        ['a ./ glob one folder down', 'head -n 20 ./*/*.csv'],
        ['a recursive glob', 'cat **/*.csv'],
        ['a glob on a report file suffix', 'tail -n +1 */*_stats.csv'],
        ['a glob after a recursive listing', 'ls -R && cat */*.csv'],
        ['a find from . by *.csv', "find . -name '*.csv' -exec cat {} +"],
        [
          'a find with no start path piped to xargs',
          'find -type f -name "*.csv" | xargs head -5',
        ],
        [
          'a find from . by a case-insensitive *.csv with a depth limit',
          "find . -maxdepth 2 -iname '*.csv' -print -exec head -3 {} \\;",
        ],
        [
          'a shell loop over the glob',
          bashLc(`for f in */*.csv; do printf '%s\\n' "== $f"; cat "$f"; done`),
        ],
      ])(
        'includes a call reading the report CSVs through %s',
        (_label, read) => {
          expect(indexesOf([report(), call(read, { result: csv })])).toEqual([
            0, 1,
          ]);
        }
      );

      it.each([
        [
          'the current directory as the output directory',
          'supabase inspect report --local --output-dir .',
          'cat */*.csv',
        ],
        [
          'a relative output directory',
          'supabase inspect report --local --output-dir out',
          'cat out/*/*.csv',
        ],
        [
          'an absolute output directory',
          'supabase inspect report --local --output-dir /tmp/r',
          'head /tmp/r/*/*.csv',
        ],
      ])('includes a glob read after a report into %s', (_label, run, read) => {
        expect(indexesOf([call(run), call(read, { result: csv })])).toEqual([
          0, 1,
        ]);
      });

      it.each([
        ['both calls run in the same directory', '/workspace', '/workspace'],
        ['the reader has no recorded directory', '/workspace', undefined],
        ['the report has no recorded directory', undefined, '/workspace'],
      ])('includes a glob read when %s', (_label, reportCwd, readCwd) => {
        expect(
          indexesOf([
            call('supabase inspect report --local', {
              result: RULES,
              cwd: reportCwd,
            }),
            call('cat */*.csv', { result: csv, cwd: readCwd }),
          ])
        ).toEqual([0, 1]);
      });

      it('lists a glob read in the same call as the report once, as a candidate', () => {
        const evidence = evidenceOf([
          call('supabase inspect report --local && cat */*.csv', {
            result: csv,
          }),
        ]);
        expect(
          evidence.map(({ commandIndex, kind }) => [commandIndex, kind])
        ).toEqual([[0, 'candidate']]);
      });

      it.each([
        ['a bare glob, since the report CSVs are a folder down', 'cat *.csv'],
        ['a glob under another folder', 'cat data/*/*.csv'],
        ['a glob under an absolute path', 'cat /tmp/exports/*/*.csv'],
        ['a glob under the home directory', 'cat ~/exports/*/*.csv'],
        [
          'a find from another directory',
          "find /tmp -name '*.csv' -exec cat {} +",
        ],
        ['a glob over backup files', 'cat */*.csv.bak'],
        ['a find by a backup file pattern', 'find . -name *.csv.bak'],
      ])('leaves out a call reading %s', (_label, read) => {
        expect(indexesOf([report(), call(read, { result: csv })])).toEqual([0]);
      });

      it('leaves out a glob read after a report of another kind', () => {
        expect(
          indexesOf([
            call('supabase inspect db outliers --local'),
            call('cat */*.csv', { result: csv }),
          ])
        ).toEqual([0]);
      });

      it('leaves out a glob read before the report', () => {
        expect(
          indexesOf([call('cat */*.csv', { result: csv }), report()])
        ).toEqual([1]);
      });

      it('leaves out a glob read run in another directory than the report', () => {
        expect(
          indexesOf([
            call('supabase inspect report --local', {
              result: RULES,
              cwd: '/workspace',
            }),
            call('cat */*.csv', { result: csv, cwd: '/tmp' }),
          ])
        ).toEqual([0]);
      });

      it.each([
        [
          'an absolute output directory',
          'supabase inspect report --local --output-dir /tmp/r',
        ],
        [
          'a relative output directory',
          'supabase inspect report --local --output-dir reports',
        ],
      ])('leaves out a glob read after a report into %s', (_label, run) => {
        expect(
          indexesOf([
            call(run, { result: RULES, cwd: '/workspace' }),
            call('cat */*.csv', { result: csv, cwd: '/workspace' }),
          ])
        ).toEqual([0]);
      });
    });

    describe('after a redirect', () => {
      it.each([
        [
          'a quoted target inside a double-quoted wrapper',
          bashLc(
            `supabase inspect db outliers --local > "/tmp/outliers.txt" 2>&1; echo 'saved'`
          ),
          'cat /tmp/outliers.txt',
        ],
        [
          'an unquoted target inside a double-quoted wrapper',
          bashLc(
            `supabase inspect db outliers --local > /tmp/o.txt 2>&1; echo 'saved'`
          ),
          'cat /tmp/o.txt',
        ],
        [
          'a ./ target read without the ./',
          'supabase inspect db outliers --local > ./outliers.txt 2>&1',
          'cat outliers.txt',
        ],
        [
          'an absolute target read by name from its directory',
          'supabase inspect db outliers --local > /tmp/reports/o.txt',
          'cd /tmp/reports && cat o.txt',
        ],
        [
          'a relative target read by name from its directory',
          'supabase inspect db outliers --local > reports/o.txt',
          'cd reports && cat o.txt',
        ],
      ])('follows %s', (_label, run, read) => {
        expect(
          indexesOf([call(run), call(read, { result: OUTLIERS })])
        ).toEqual([0, 1]);
      });

      it.each([
        [
          'an awk comparison against a number',
          `supabase inspect db table-stats --local | awk -F'|' '$6 > 5'`,
          'psql "$DB" -p 54322 -c "select count(*) from orders"',
        ],
        [
          'an awk comparison against a longer number',
          `supabase inspect db table-stats --local | awk -F'|' '$6 > 100'`,
          'psql "$DB" -c "select 100 from orders"',
        ],
        [
          'an awk comparison with an equals sign',
          `supabase inspect db table-stats --local | awk -F'|' '$6 >= 5'`,
          'psql "$DB" -c "select * from orders where id=5"',
        ],
        [
          'a json arrow operator',
          `supabase inspect db outliers --local && psql "$DB" -c "select data->>'x' from events"`,
          'grep -n index supabase/config.toml',
        ],
        [
          'an escaped quote around a redirect target',
          bashLc(
            `supabase inspect db outliers --local > "/tmp/outliers.txt" 2>&1; echo 'saved'`
          ),
          `printf '%s\\n' '--- seed ---'; sed -n '1,5p' supabase/seed.sql`,
        ],
      ])('does not take %s for an output path', (_label, run, other) => {
        expect(
          indexesOf([call(run), call(other, { result: 'public.orders' })])
        ).toEqual([0]);
      });
    });
  });
});

describe('gateInspectEvidence', () => {
  const gate = (toolCalls: ToolCallRecord[]) =>
    gateInspectEvidence(runsOf(toolCalls), evidenceOf(toolCalls));

  it('fails without a judge when no inspect report ran', () => {
    expect(gate([call('supabase start')])).toEqual({
      name: INSPECT_CHECK_NAME,
      passed: false,
      notes: 'no supabase inspect report ran',
    });
    expect(gate([])).toMatchObject({ notes: 'no supabase inspect report ran' });
  });

  it('fails without a judge when no evidence names orders, listing the runs with errored ones marked', () => {
    expect(
      gate([
        call('supabase inspect db outliers', { error: NO_PROJECT_REF }),
        inspect('supabase inspect db calls --local', UNRELATED_OUTLIERS),
      ])
    ).toEqual({
      name: INSPECT_CHECK_NAME,
      passed: false,
      notes:
        'tool call 1: supabase inspect db outliers (errored); tool call 2: supabase inspect db calls; no inspect output named the orders table',
    });
  });

  it('fails without a judge for a candidate that parsing found no run in', () => {
    expect(
      gate([inspect('timeout 120 bash -lc "supabase inspect db"', 'usage')])
    ).toMatchObject({
      passed: false,
      notes: 'no inspect output named the orders table',
    });
  });

  it('hands over to the judge when a candidate call names orders', () => {
    expect(
      gate([
        call('supabase inspect db outliers 2>&1 || psql "$DB" -c "select 1"', {
          result: `${NO_PROJECT_REF}\n public.orders`,
        }),
      ])
    ).toBeUndefined();
  });

  it('hands over to the judge when only a later call names orders', () => {
    expect(
      gate([
        call('supabase inspect db outliers --local > /tmp/o.txt'),
        call('cat /tmp/o.txt', { result: OUTLIERS }),
      ])
    ).toBeUndefined();
  });

  it('does not let a read of an unrelated file hand over to the judge', () => {
    expect(
      gate([
        call('supabase inspect db outliers --local > /tmp/o.txt'),
        call('cat supabase/seed.sql', { result: 'insert into public.orders' }),
      ])?.passed
    ).toBe(false);
  });
});

describe('formatInspectJudgeInput', () => {
  const NO_REF_AND_ROW = `${NO_PROJECT_REF}\n select id from public.orders where customer_email = $1 |   200`;

  it('shows the whole command and output of a refused inspect with a psql fallback', () => {
    const command = `supabase inspect db outliers 2>&1 || psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "select query, calls from extensions.pg_stat_statements order by total_exec_time desc limit 5"`;
    const input = formatInspectJudgeInput(
      evidenceOf([
        call('supabase start'),
        call(command, { result: NO_REF_AND_ROW }),
      ])
    );
    expect(input).toBe(
      `Tool call 2 (candidate)\nCommand:\n${command}\nOutput:\n${NO_REF_AND_ROW}\n`
    );
  });

  it('shows a printf separator call and a call that rg-ed the project', () => {
    const printfCall = `printf '%s\\n' '--- outliers ---'; supabase inspect db outliers --local`;
    const rgCall =
      'supabase inspect db outliers 2>&1 | head -5; rg -n customer_email';
    const input = formatInspectJudgeInput(
      evidenceOf([
        call(printfCall, { result: `--- outliers ---\n${OUTLIERS}` }),
        call(rgCall, {
          result: `${NO_PROJECT_REF}\nsupabase/seed.sql:4:insert into public.orders`,
        }),
      ])
    );
    expect(input).toContain(`Tool call 1 (candidate)\nCommand:\n${printfCall}`);
    expect(input).toContain(`--- outliers ---\n${OUTLIERS}`);
    expect(input).toContain(`Tool call 2 (candidate)\nCommand:\n${rgCall}`);
    expect(input).toContain('supabase/seed.sql:4:insert into public.orders');
  });

  it('marks a later call and does not truncate a long output', () => {
    const long = `${'select 1 from public.orders;\n'.repeat(5000)}`;
    expect(long.length).toBeGreaterThan(100_000);
    const input = formatInspectJudgeInput(
      evidenceOf([
        call('supabase inspect db outliers --local > /tmp/o.txt'),
        call('cat /tmp/o.txt', { result: long }),
      ])
    );
    expect(input).toContain(`Tool call 2 (${LATER})\nCommand:\ncat /tmp/o.txt`);
    expect(input).toContain(long);
  });

  it('separates the calls with a blank line', () => {
    const input = formatInspectJudgeInput(
      evidenceOf([
        inspect('supabase inspect db outliers --local', OUTLIERS),
        inspect('supabase inspect db calls --local', OUTLIERS),
      ])
    );
    expect(input.split('\n\nTool call ')).toHaveLength(2);
  });

  it('is empty when there is no evidence', () => {
    expect(formatInspectJudgeInput([])).toBe('');
  });
});
