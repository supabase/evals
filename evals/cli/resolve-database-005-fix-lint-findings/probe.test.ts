// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-005-fix-lint-findings
import { readFileSync } from 'node:fs';
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { describeFailure, shellQuote } from '../lib/shell.js';
import {
  buildProbeScript,
  parseProbeOutput,
  type PhaseReport,
  type ReplayFile,
  runProbe,
  stripTransactionControl,
} from './probe.js';

const SUB_A = '6f1c2a3e-0b7d-4c55-9a1e-2d3f4b5c6d71';
const SUB_B = 'b8e4d2c1-7a6f-4e3d-8c2b-1a0f9e8d7c62';
const SUBS = [SUB_A, SUB_B];

const nonBlank = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

describe('stripTransactionControl', () => {
  it.each([
    'begin;',
    'BEGIN;',
    'Begin Work;',
    'begin transaction;',
    'start transaction;',
    'START TRANSACTION;',
    'commit;',
    'COMMIT;',
    'commit work;',
    'commit transaction;',
    'end work;',
    'end transaction;',
    '  begin;  ',
    '\tcommit;\t',
    'begin; -- wrap the migration',
    'commit;-- done',
    'begin ;',
  ])('removes the line %j', (line) => {
    const sql = `create table a (id int);\n${line}\ncreate table b (id int);\n`;
    expect(nonBlank(stripTransactionControl(sql))).toEqual([
      'create table a (id int);',
      'create table b (id int);',
    ]);
  });

  it('removes transaction control from CRLF files', () => {
    const sql = 'begin;\r\ncreate table a (id int);\r\ncommit;\r\n';
    expect(nonBlank(stripTransactionControl(sql))).toEqual([
      'create table a (id int);',
    ]);
  });

  it('removes every wrapper line in a file', () => {
    const sql =
      'begin;\ncreate table a (id int);\ncommit;\nbegin;\ndrop table a;\ncommit;\n';
    expect(nonBlank(stripTransactionControl(sql))).toEqual([
      'create table a (id int);',
      'drop table a;',
    ]);
  });

  it.each([
    ['a bare end; closing a plpgsql block', 'end;'],
    ['an upper-case END;', 'END;'],
    ['rollback;', 'rollback;'],
    ['a comment naming the statement', '-- commit;'],
    ['a statement that contains the word', "select 'begin;' as word;"],
    ['a table named like the keyword', 'insert into commit_log values (1);'],
    ['end if;', '  end if;'],
    ['end loop;', '  end loop;'],
    ['begin without a semicolon, as plpgsql opens a block', 'begin'],
    ['an indented plpgsql begin', '  begin'],
  ])('keeps %s', (_label, line) => {
    const sql = `create table a (id int);\n${line}\ncreate table b (id int);\n`;
    expect(stripTransactionControl(sql)).toBe(sql);
  });

  it('leaves a plpgsql function body intact', () => {
    const sql = [
      'begin;',
      'create function public.f() returns int language plpgsql as $$',
      'begin',
      '  return 1;',
      'end;',
      '$$;',
      'commit;',
    ].join('\n');
    expect(nonBlank(stripTransactionControl(sql))).toEqual([
      'create function public.f() returns int language plpgsql as $$',
      'begin',
      'return 1;',
      'end;',
      '$$;',
    ]);
  });

  it('returns sql without transaction control unchanged', () => {
    const sql = 'create table a (id int);\n';
    expect(stripTransactionControl(sql)).toBe(sql);
  });
});

describe('buildProbeScript', () => {
  const probeSql = readFileSync(
    new URL('./probe.sql', import.meta.url),
    'utf8'
  );
  const FILES: ReplayFile[] = [
    { name: '20260101000000_a.sql', sql: 'create table a (id int);\n' },
    { name: '20260201000000_b.sql', sql: 'create table b (id int);\n' },
  ];
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const subArray = (subs: readonly string[]) =>
    `array[${subs.map(quote).join(', ')}]`;
  const ORDER_IDS = 'array[1, 2, 3]::bigint[]';
  const behaviourArgs = (subs: readonly string[]) =>
    `${subArray(subs)}, ${ORDER_IDS}`;
  const payloadOf = (script: string) => {
    const encoded = script.match(
      /decode\('([A-Za-z0-9+/=]+)', 'base64'\)/
    )?.[1];
    expect(encoded).toBeDefined();
    return JSON.parse(Buffer.from(encoded ?? '', 'base64').toString('utf8'));
  };
  const scriptLines = (files = FILES, subs = SUBS) =>
    nonBlank(buildProbeScript(files, subs));

  const CREATE_PLPGSQL_CHECK =
    'do $$ begin create extension if not exists plpgsql_check schema extensions; exception when others then null; end $$;';
  const PRELUDE = [
    'begin;',
    "set local lock_timeout = '10s';",
    'set local client_min_messages = warning;',
    CREATE_PLPGSQL_CHECK,
  ];

  it('opens a transaction first and rolls it back last, so nothing the probe does persists', () => {
    const lines = scriptLines();
    expect(lines[0]).toBe('begin;');
    expect(lines.at(-1)).toBe('rollback;');
    expect(lines.filter((line) => /^commit\b/i.test(line))).toEqual([]);
  });

  it('sets timeouts, tries plpgsql_check, then defines the probe functions', () => {
    const lines = scriptLines();
    expect(lines.slice(0, PRELUDE.length)).toEqual(PRELUDE);
    const body = nonBlank(probeSql);
    expect(lines.slice(PRELUDE.length, PRELUDE.length + body.length)).toEqual(
      body
    );
  });

  it('runs history, live findings and live behaviour, then replays the files', () => {
    const lines = scriptLines();
    const afterProbe = lines.slice(PRELUDE.length + nonBlank(probeSql).length);
    expect(afterProbe.slice(0, 3)).toEqual([
      'select pg_temp.eval_history();',
      "select pg_temp.eval_findings('live');",
      `select pg_temp.eval_behaviour('live', ${behaviourArgs(SUBS)});`,
    ]);
    expect(afterProbe[3]).toMatch(
      /^select pg_temp\.eval_replay\(convert_from\(decode\('[A-Za-z0-9+/=]*', 'base64'\), 'UTF8'\)::jsonb\);$/
    );
  });

  it('resets the session, restores the timeouts, recreates plpgsql_check and probes the replayed database', () => {
    const lines = scriptLines();
    expect(lines.slice(-7)).toEqual([
      'reset all;',
      "set local lock_timeout = '10s';",
      'set local client_min_messages = warning;',
      CREATE_PLPGSQL_CHECK,
      "select pg_temp.eval_findings('replay');",
      `select pg_temp.eval_behaviour('replay', ${behaviourArgs(SUBS)});`,
      'rollback;',
    ]);
  });

  it('creates plpgsql_check only before the probe functions and again after the replay', () => {
    const lines = scriptLines();
    expect(lines.filter((line) => line === CREATE_PLPGSQL_CHECK)).toHaveLength(
      2
    );
    const replayAt = lines.findIndex((line) =>
      line.startsWith('select pg_temp.eval_replay(')
    );
    expect(lines.slice(PRELUDE.length, replayAt + 1)).not.toContain(
      CREATE_PLPGSQL_CHECK
    );
  });

  it('passes the seeded order ids to both behaviour probes', () => {
    const script = buildProbeScript(FILES, SUBS);
    expect(script.match(/array\[1, 2, 3\]::bigint\[\]\);/g)).toHaveLength(2);
  });

  it('ships the files as base64 JSON of name and sql in order', () => {
    expect(payloadOf(buildProbeScript(FILES, SUBS))).toEqual(FILES);
  });

  it('ships an empty array when there are no files', () => {
    expect(payloadOf(buildProbeScript([], SUBS))).toEqual([]);
  });

  it('strips transaction control from each file before encoding it', () => {
    const wrapped: ReplayFile[] = [
      {
        name: '20260301000000_c.sql',
        sql: [
          'begin;',
          'create function public.f() returns int language plpgsql as $$',
          'begin',
          '  return 1;',
          'end;',
          '$$;',
          'commit;',
          '',
        ].join('\n'),
      },
    ];
    const [file] = payloadOf(buildProbeScript(wrapped, SUBS));
    expect(file.name).toBe('20260301000000_c.sql');
    expect(file.sql).not.toMatch(/^\s*(begin|commit)\s*;/im);
    expect(nonBlank(file.sql)).toEqual([
      'create function public.f() returns int language plpgsql as $$',
      'begin',
      'return 1;',
      'end;',
      '$$;',
    ]);
  });

  it('carries sql that would break dollar quoting or string literals through the encoding', () => {
    const awkward: ReplayFile[] = [
      {
        name: "20260401000000_it's.sql",
        sql: "do $probe$ begin raise notice 'it''s $$ é 🚀'; end $probe$;\n$$; drop table x; --\n",
      },
    ];
    const script = buildProbeScript(awkward, SUBS);
    expect(payloadOf(script)).toEqual(awkward);
    expect(script).not.toContain('drop table x');
  });

  it('keeps file contents out of the script text', () => {
    expect(buildProbeScript(FILES, SUBS)).not.toContain('create table a');
  });

  it('quotes each sub as a sql literal with single quotes doubled', () => {
    const hostile = "x'); drop table orders; --";
    const script = buildProbeScript(FILES, [SUB_A, hostile]);
    const quoted =
      "array['6f1c2a3e-0b7d-4c55-9a1e-2d3f4b5c6d71', 'x''); drop table orders; --']";
    expect(script).toContain(
      `select pg_temp.eval_behaviour('live', ${quoted}, ${ORDER_IDS});`
    );
    expect(script).toContain(
      `select pg_temp.eval_behaviour('replay', ${quoted}, ${ORDER_IDS});`
    );
  });
});

describe('probe.sql', () => {
  const sql = readFileSync(new URL('./probe.sql', import.meta.url), 'utf8');
  const functionBody = (name: string) =>
    sql.match(
      new RegExp(`create function pg_temp\\.${name}\\([\\s\\S]*?\\$probe\\$;`)
    )?.[0] ?? '';

  it('defines the managed schema list first, once, as an immutable sql function', () => {
    expect(
      sql.startsWith('create function pg_temp.eval_managed_schemas()')
    ).toBe(true);
    expect(functionBody('eval_managed_schemas')).toMatch(
      /returns text\[\]\s+language sql\s+immutable/
    );
    expect(sql.match(/'graphql_public'/g)).toHaveLength(1);
  });

  it('reads the managed schema list, schema-qualified, in the findings and the replay', () => {
    const call = /pg_temp\.eval_managed_schemas\(\)/g;
    expect(functionBody('eval_findings').match(call)).toHaveLength(5);
    expect(functionBody('eval_replay').match(call)).toHaveLength(1);
    expect(functionBody('eval_findings')).not.toMatch(/\bexcluded\b/);
  });

  it('does not drop sequences owned by a column or identity ahead of their table', () => {
    expect(functionBody('eval_replay')).toMatch(
      /not exists \(select 1 from pg_depend d where d\.objid = c\.oid and d\.deptype in \('a', 'i'\)\)/
    );
  });

  it('drops plpgsql_check at the start of the replay, before any drop is computed', () => {
    const replay = functionBody('eval_replay');
    const dropExtension = replay.indexOf(
      'drop extension if exists plpgsql_check;'
    );
    expect(dropExtension).toBeGreaterThan(replay.indexOf('begin\n'));
    expect(dropExtension).toBeLessThan(replay.indexOf('array_agg(d)'));
  });

  it('measures order_total on the seeded orders a reader cannot see', () => {
    const behaviour = functionBody('eval_behaviour');
    expect(behaviour).toContain('order_ids bigint[]');
    expect(behaviour).toContain(
      "'select coalesce(sum(public.order_total(p_order_id => x)), 0)::text from unnest($1) as x where x not in (select o.id from public.orders o)' into foreign_total using order_ids"
    );
    expect(behaviour).toContain("'foreign_total', foreign_total");
  });

  it('declares no unused variables and no unused ordinality', () => {
    expect(sql).not.toMatch(/with ordinality/);
    expect(functionBody('eval_findings')).not.toMatch(
      /\b(usr record|n bigint|m bigint|total text)\b/
    );
  });
});

const HISTORY_ERROR = String.raw`{"phase" : "live", "probe" : "history-error", "error" : "relation \"supabase_migrations.schema_migrations\" does not exist"}`;

const advisorRows = (phase: string) => [
  `{"phase" : "${phase}", "probe" : "advisor", "name" : "auth_rls_initplan", "object" : "public.orders policy Users read their own orders"}`,
  `{"phase" : "${phase}", "probe" : "advisor", "name" : "function_search_path_mutable", "object" : "set_updated_at()"}`,
  `{"phase" : "${phase}", "probe" : "advisor", "name" : "policy_exists_rls_disabled", "object" : "public.order_items"}`,
  `{"phase" : "${phase}", "probe" : "advisor", "name" : "rls_disabled_in_public", "object" : "public.order_items"}`,
  `{"phase" : "${phase}", "probe" : "advisor-done"}`,
];

const lintRows = (phase: string) => [
  `{"phase" : "${phase}", "probe" : "lint", "function" : "order_total(bigint)", "level" : "error", "message" : "column oi.price does not exist"}`,
  `{"phase" : "${phase}", "probe" : "lint-done"}`,
];

const seededState = (phase: string) => [
  ...advisorRows(phase),
  ...lintRows(phase),
  `{"phase" : "${phase}", "probe" : "reader-error", "role" : "authenticated", "sub" : "${SUB_A}", "sqlstate" : "42703", "error" : "column oi.price does not exist"}`,
  `{"phase" : "${phase}", "probe" : "reader-error", "role" : "authenticated", "sub" : "${SUB_B}", "sqlstate" : "42703", "error" : "column oi.price does not exist"}`,
  `{"phase" : "${phase}", "probe" : "reader", "role" : "anon", "sub" : null, "orders" : 0, "items" : 4, "totals" : [], "foreign_total" : "0"}`,
  `{"phase" : "${phase}", "probe" : "trigger", "stamped" : true}`,
];

const fixedState = (phase: string) => [
  `{"phase" : "${phase}", "probe" : "advisor-done"}`,
  `{"phase" : "${phase}", "probe" : "lint-done"}`,
  `{"phase" : "${phase}", "probe" : "reader", "role" : "authenticated", "sub" : "${SUB_A}", "orders" : 2, "items" : 3, "totals" : ["30.00", "12.00"], "foreign_total" : "0"}`,
  `{"phase" : "${phase}", "probe" : "reader", "role" : "authenticated", "sub" : "${SUB_B}", "orders" : 1, "items" : 1, "totals" : ["99.99"], "foreign_total" : "0"}`,
  `{"phase" : "${phase}", "probe" : "reader", "role" : "anon", "sub" : null, "orders" : 0, "items" : 0, "totals" : [], "foreign_total" : "0"}`,
  `{"phase" : "${phase}", "probe" : "trigger", "stamped" : true}`,
];

const REPLAY_DONE = (files: number) =>
  `{"phase" : "replay", "probe" : "replay-done", "files" : ${files}}`;

const LIVE_SEEDED = [HISTORY_ERROR, ...seededState('live')];
const output = (...rows: string[][]) => `${rows.flat().join('\n')}\n`;

const SEEDED_PHASE: PhaseReport = {
  advisors: [
    {
      name: 'auth_rls_initplan',
      object: 'public.orders policy Users read their own orders',
    },
    { name: 'function_search_path_mutable', object: 'set_updated_at()' },
    { name: 'policy_exists_rls_disabled', object: 'public.order_items' },
    { name: 'rls_disabled_in_public', object: 'public.order_items' },
  ],
  advisorsDone: true,
  lint: [
    {
      function: 'order_total(bigint)',
      level: 'error',
      message: 'column oi.price does not exist',
    },
  ],
  lintDone: true,
  readers: [
    {
      ok: false,
      role: 'authenticated',
      sub: SUB_A,
      sqlstate: '42703',
      error: 'column oi.price does not exist',
    },
    {
      ok: false,
      role: 'authenticated',
      sub: SUB_B,
      sqlstate: '42703',
      error: 'column oi.price does not exist',
    },
    {
      ok: true,
      role: 'anon',
      sub: null,
      orders: 0,
      items: 4,
      totals: [],
      foreignTotal: '0',
    },
  ],
  trigger: { stamped: true },
};

const FIXED_PHASE: PhaseReport = {
  advisors: [],
  advisorsDone: true,
  lint: [],
  lintDone: true,
  readers: [
    {
      ok: true,
      role: 'authenticated',
      sub: SUB_A,
      orders: 2,
      items: 3,
      totals: ['30.00', '12.00'],
      foreignTotal: '0',
    },
    {
      ok: true,
      role: 'authenticated',
      sub: SUB_B,
      orders: 1,
      items: 1,
      totals: ['99.99'],
      foreignTotal: '0',
    },
    {
      ok: true,
      role: 'anon',
      sub: null,
      orders: 0,
      items: 0,
      totals: [],
      foreignTotal: '0',
    },
  ],
  trigger: { stamped: true },
};

const HISTORY_UNAVAILABLE = {
  error: 'relation "supabase_migrations.schema_migrations" does not exist',
};

describe('parseProbeOutput', () => {
  it('reads the seeded database: four advisor findings, one lint error, broken readers, and the unchanged replay', () => {
    const report = parseProbeOutput(
      output(LIVE_SEEDED, [REPLAY_DONE(4)], seededState('replay'))
    );
    expect(report).toEqual({
      history: HISTORY_UNAVAILABLE,
      live: SEEDED_PHASE,
      replay: { ok: true, files: 4 },
      replayed: SEEDED_PHASE,
      unparsed: [],
    });
  });

  it('reads a fixed replay as clean with every reader answering', () => {
    const report = parseProbeOutput(
      output(LIVE_SEEDED, [REPLAY_DONE(5)], fixedState('replay'))
    );
    expect(report.live).toEqual(SEEDED_PHASE);
    expect(report.replay).toEqual({ ok: true, files: 5 });
    expect(report.replayed).toEqual(FIXED_PHASE);
  });

  it('keeps the live phase separate from the replayed one', () => {
    const report = parseProbeOutput(
      output(LIVE_SEEDED, [REPLAY_DONE(5)], fixedState('replay'))
    );
    expect(report.live.advisors).toHaveLength(4);
    expect(report.replayed.advisors).toEqual([]);
    expect(report.live.readers.filter((reader) => reader.ok)).toHaveLength(1);
    expect(report.replayed.readers.filter((reader) => reader.ok)).toHaveLength(
      3
    );
  });

  it('reports a failed replay with its file and sqlstate while still reading the post-replay rows', () => {
    const replayError = String.raw`{"phase" : "replay", "probe" : "replay-error", "file" : "20261022000000_fix.sql", "sqlstate" : "42710", "error" : "extension \"pgcrypto\" already exists"}`;
    const report = parseProbeOutput(
      output(LIVE_SEEDED, [replayError], seededState('replay'))
    );
    expect(report.replay).toEqual({
      ok: false,
      file: '20261022000000_fix.sql',
      sqlstate: '42710',
      error: 'extension "pgcrypto" already exists',
    });
    expect(report.replayed).toEqual(SEEDED_PHASE);
  });

  it('keeps anon rows with a null sub and totals as the strings Postgres printed', () => {
    const { live, replayed } = parseProbeOutput(
      output(LIVE_SEEDED, [REPLAY_DONE(5)], fixedState('replay'))
    );
    expect(live.readers.at(-1)).toMatchObject({ role: 'anon', sub: null });
    expect(replayed.readers[0]).toMatchObject({ totals: ['30.00', '12.00'] });
  });

  it('reads the cross-user total as the string Postgres printed, and an empty string when the row has none', () => {
    const row = (extra: string) =>
      parseProbeOutput(
        output([
          `{"phase" : "live", "probe" : "reader", "role" : "authenticated", "sub" : "${SUB_A}", "orders" : 2, "items" : 3, "totals" : ["30.00", "12.00"]${extra}}`,
        ])
      ).live.readers[0];
    expect(row(', "foreign_total" : "99.99"')).toMatchObject({
      foreignTotal: '99.99',
    });
    expect(row(', "foreign_total" : "0.00"')).toMatchObject({
      foreignTotal: '0.00',
    });
    expect(row('')).toMatchObject({ foreignTotal: '' });
    expect(row(', "foreign_total" : null')).toMatchObject({ foreignTotal: '' });
  });

  it('records the migration versions the history holds', () => {
    const row =
      '{"phase" : "live", "probe" : "history", "versions" : ["20260101000000", "20260201000000"]}';
    expect(parseProbeOutput(output([row])).history).toEqual({
      versions: ['20260101000000', '20260201000000'],
    });
  });

  it('records an empty history as no versions, not as missing', () => {
    const row = '{"phase" : "live", "probe" : "history", "versions" : []}';
    expect(parseProbeOutput(output([row])).history).toEqual({ versions: [] });
  });

  it('records why the history could not be read', () => {
    expect(parseProbeOutput(output([HISTORY_ERROR])).history).toEqual(
      HISTORY_UNAVAILABLE
    );
  });

  it('records advisor, lint and trigger probe errors without marking the probe done', () => {
    const report = parseProbeOutput(
      output([
        '{"phase" : "live", "probe" : "advisor-error", "error" : "permission denied for table pg_policy"}',
        '{"phase" : "live", "probe" : "lint-error", "error" : "function plpgsql_check_function(oid) does not exist"}',
        '{"phase" : "live", "probe" : "trigger-error", "error" : "relation \\"public.orders\\" does not exist"}',
      ])
    );
    expect(report.live.advisorsDone).toBe(false);
    expect(report.live.advisorsError).toBe(
      'permission denied for table pg_policy'
    );
    expect(report.live.lintDone).toBe(false);
    expect(report.live.lintError).toBe(
      'function plpgsql_check_function(oid) does not exist'
    );
    expect(report.live.trigger).toEqual({
      error: 'relation "public.orders" does not exist',
    });
  });

  it('records trigger outcomes of false and null', () => {
    const trigger = (stamped: boolean | null) =>
      parseProbeOutput(
        output([
          `{"phase" : "live", "probe" : "trigger", "stamped" : ${stamped}}`,
        ])
      ).live.trigger;
    expect(trigger(false)).toEqual({ stamped: false });
    expect(trigger(null)).toEqual({ stamped: null });
  });

  it('ignores blank lines and keeps other non-JSON lines in unparsed', () => {
    const report = parseProbeOutput(
      [
        '',
        'NOTICE: something psql printed',
        '   ',
        ...fixedState('live'),
        '{not json',
        '',
      ].join('\n')
    );
    expect(report.unparsed).toEqual([
      'NOTICE: something psql printed',
      '{not json',
    ]);
    expect(report.live).toEqual(FIXED_PHASE);
  });

  it('does not throw on JSON lines that are not probe rows, and keeps them in unparsed', () => {
    const report = parseProbeOutput(
      output(['null', '42', ...fixedState('live')])
    );
    expect(report.unparsed).toEqual(['null', '42']);
    expect(report.live).toEqual(FIXED_PHASE);
  });

  it('reports nothing finished for empty output', () => {
    expect(parseProbeOutput('')).toEqual({
      history: undefined,
      live: {
        advisors: [],
        advisorsDone: false,
        lint: [],
        lintDone: false,
        readers: [],
      },
      replay: undefined,
      replayed: {
        advisors: [],
        advisorsDone: false,
        lint: [],
        lintDone: false,
        readers: [],
      },
      unparsed: [],
    });
  });
});

describe('runProbe', () => {
  const FILES: ReplayFile[] = [
    { name: '20260101000000_a.sql', sql: 'create table a (id int);\n' },
  ];
  const DB_URL = "postgresql://postgres:p@ss'w0rd@127.0.0.1:54322/postgres";

  function fakeExec(outcome: CommandResult | Error) {
    const calls: Array<{ command: string; timeoutMs?: number }> = [];
    const ctx: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async (command, options) => {
        calls.push({ command, timeoutMs: options?.timeoutMs });
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    };
    return { ctx, calls };
  }

  const succeeded = (stdout: string): CommandResult => ({
    ok: true,
    exitCode: 0,
    stdout,
    stderr: '',
  });

  it('pipes the base64 script through base64 -d into psql with the quoted database url', async () => {
    const { ctx, calls } = fakeExec(succeeded(''));
    await runProbe(ctx, DB_URL, FILES, SUBS);

    expect(calls).toHaveLength(1);
    const { command } = calls[0];
    const encoded = command.match(
      /^printf '%s' '?([A-Za-z0-9+/=]+)'? \| base64 -d \| /
    )?.[1];
    expect(encoded).toBeDefined();
    expect(Buffer.from(encoded ?? '', 'base64').toString('utf8')).toBe(
      buildProbeScript(FILES, SUBS)
    );
    expect(
      command.endsWith(
        ` | psql ${shellQuote(DB_URL)} -X -q -tA -v ON_ERROR_STOP=1`
      )
    ).toBe(true);
  });

  it('allows the probe three minutes', async () => {
    const { ctx, calls } = fakeExec(succeeded(''));
    await runProbe(ctx, DB_URL, FILES, SUBS);
    expect(calls[0].timeoutMs).toBe(180_000);
  });

  it('returns the parsed report when psql succeeds', async () => {
    const stdout = output(LIVE_SEEDED, [REPLAY_DONE(5)], fixedState('replay'));
    const { ctx } = fakeExec(succeeded(stdout));

    const result = await runProbe(ctx, DB_URL, FILES, SUBS);

    expect(result).toEqual({ ok: true, report: parseProbeOutput(stdout) });
    if (result.ok) {
      expect(result.report.replay).toEqual({ ok: true, files: 5 });
    }
  });

  it('reports the exit and stderr when psql fails, even if it printed some rows first', async () => {
    const failure: CommandResult = {
      ok: false,
      exitCode: 3,
      stdout: output(LIVE_SEEDED),
      stderr: 'psql: error: connection to server failed',
    };
    const { ctx } = fakeExec(failure);

    expect(await runProbe(ctx, DB_URL, FILES, SUBS)).toEqual({
      ok: false,
      notes: describeFailure(failure),
    });
  });

  it('names the exit code in the failure notes', async () => {
    const { ctx } = fakeExec({
      ok: false,
      exitCode: 3,
      stdout: '',
      stderr: 'psql: error: connection refused',
    });
    expect(await runProbe(ctx, DB_URL, FILES, SUBS)).toEqual({
      ok: false,
      notes: 'exit 3: psql: error: connection refused',
    });
  });

  it('returns the message instead of throwing when exec throws', async () => {
    const { ctx } = fakeExec(new Error('sandbox gone'));
    expect(await runProbe(ctx, DB_URL, FILES, SUBS)).toEqual({
      ok: false,
      notes: 'sandbox gone',
    });
  });
});
