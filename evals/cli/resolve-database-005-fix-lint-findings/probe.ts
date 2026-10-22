import { readFileSync } from 'node:fs';
import type { LocalStackEvalContext } from '@supabase-evals/core';
import { describeFailure, errorMessage, shellQuote } from '../lib/shell.js';

const PROBE_SQL = readFileSync(new URL('./probe.sql', import.meta.url), 'utf8');

export type ReplayFile = { name: string; sql: string };

export type LintIssue = { function: string; level: string; message: string };
export type AdvisorFinding = { name: string; object: string };

export type ReaderResult =
  | {
      ok: true;
      role: 'authenticated' | 'anon';
      sub: string | null;
      orders: number;
      items: number;
      totals: string[];
    }
  | {
      ok: false;
      role: 'authenticated' | 'anon';
      sub: string | null;
      sqlstate: string;
      error: string;
    };

export type PhaseReport = {
  advisors: AdvisorFinding[];
  advisorsDone: boolean;
  advisorsError?: string;
  lint: LintIssue[];
  lintDone: boolean;
  lintError?: string;
  readers: ReaderResult[];
  trigger?: { stamped: boolean | null } | { error: string };
};

export type ProbeReport = {
  history?: { versions: string[] } | { error: string };
  live: PhaseReport;
  replay?:
    | { ok: true; files: number }
    | { ok: false; file: string; sqlstate: string; error: string };
  replayed: PhaseReport;
  unparsed: string[];
};

export type ProbeResult =
  | { ok: true; report: ProbeReport }
  | { ok: false; notes: string };

const TRANSACTION_CONTROL_RE =
  /^[ \t]*(begin|start[ \t]+transaction|commit|end[ \t]+(work|transaction))([ \t]+(work|transaction))?[ \t]*;[ \t]*(--.*)?$/gim;

/** Drops lines that only open or close a transaction; the probe's `execute` rejects them and the CLI accepts them. */
export function stripTransactionControl(sql: string): string {
  return sql.replace(TRANSACTION_CONTROL_RE, '');
}

const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function buildProbeScript(
  files: readonly ReplayFile[],
  subs: readonly string[]
): string {
  const payload = Buffer.from(
    JSON.stringify(
      files.map(({ name, sql }) => ({
        name,
        sql: stripTransactionControl(sql),
      }))
    )
  ).toString('base64');
  const subArray = `array[${subs.map(sqlLiteral).join(', ')}]`;
  return [
    'begin;',
    "set local lock_timeout = '10s';",
    'set local client_min_messages = warning;',
    'do $$ begin create extension if not exists plpgsql_check schema extensions; exception when others then null; end $$;',
    PROBE_SQL,
    'select pg_temp.eval_history();',
    "select pg_temp.eval_findings('live');",
    `select pg_temp.eval_behaviour('live', ${subArray});`,
    `select pg_temp.eval_replay(convert_from(decode('${payload}', 'base64'), 'UTF8')::jsonb);`,
    'reset all;',
    "set local lock_timeout = '10s';",
    'set local client_min_messages = warning;',
    "select pg_temp.eval_findings('replay');",
    `select pg_temp.eval_behaviour('replay', ${subArray});`,
    'rollback;',
    '',
  ].join('\n');
}

const emptyPhase = (): PhaseReport => ({
  advisors: [],
  advisorsDone: false,
  lint: [],
  lintDone: false,
  readers: [],
});

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readReader(row: Row): ReaderResult {
  const role = row.role === 'anon' ? 'anon' : 'authenticated';
  const sub = typeof row.sub === 'string' ? row.sub : null;
  return row.probe === 'reader'
    ? {
        ok: true,
        role,
        sub,
        orders: Number(row.orders),
        items: Number(row.items),
        totals: Array.isArray(row.totals) ? row.totals.map(String) : [],
      }
    : {
        ok: false,
        role,
        sub,
        sqlstate: String(row.sqlstate),
        error: String(row.error),
      };
}

function applyPhaseRow(phase: PhaseReport, row: Row): boolean {
  switch (row.probe) {
    case 'advisor':
      phase.advisors.push({
        name: String(row.name),
        object: String(row.object),
      });
      return true;
    case 'advisor-done':
      phase.advisorsDone = true;
      return true;
    case 'advisor-error':
      phase.advisorsError = String(row.error);
      return true;
    case 'lint':
      phase.lint.push({
        function: String(row.function),
        level: String(row.level),
        message: String(row.message),
      });
      return true;
    case 'lint-done':
      phase.lintDone = true;
      return true;
    case 'lint-error':
      phase.lintError = String(row.error);
      return true;
    case 'reader':
    case 'reader-error':
      phase.readers.push(readReader(row));
      return true;
    case 'trigger':
      phase.trigger = {
        stamped: typeof row.stamped === 'boolean' ? row.stamped : null,
      };
      return true;
    case 'trigger-error':
      phase.trigger = { error: String(row.error) };
      return true;
    default:
      return false;
  }
}

function applyRow(report: ProbeReport, row: Row): boolean {
  switch (row.probe) {
    case 'history':
      report.history = {
        versions: Array.isArray(row.versions) ? row.versions.map(String) : [],
      };
      return true;
    case 'history-error':
      report.history = { error: String(row.error) };
      return true;
    case 'replay-done':
      report.replay = { ok: true, files: Number(row.files) };
      return true;
    case 'replay-error':
      report.replay = {
        ok: false,
        file: String(row.file),
        sqlstate: String(row.sqlstate),
        error: String(row.error),
      };
      return true;
    default:
      return applyPhaseRow(
        row.phase === 'replay' ? report.replayed : report.live,
        row
      );
  }
}

/** Reads the probe's JSON lines; blank lines are dropped and anything that is not a probe row lands in `unparsed`. */
export function parseProbeOutput(stdout: string): ProbeReport {
  const report: ProbeReport = {
    live: emptyPhase(),
    replayed: emptyPhase(),
    unparsed: [],
  };
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (text === '') continue;
    let row: unknown;
    try {
      row = JSON.parse(text);
    } catch {
      report.unparsed.push(text);
      continue;
    }
    if (!isRow(row) || !applyRow(report, row)) report.unparsed.push(text);
  }
  return report;
}

/** Runs the probe script through `psql` against the local database, which it leaves untouched. */
export async function runProbe(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  dbUrl: string,
  files: readonly ReplayFile[],
  subs: readonly string[]
): Promise<ProbeResult> {
  const script = Buffer.from(buildProbeScript(files, subs)).toString('base64');
  try {
    const result = await ctx.exec(
      `printf '%s' ${shellQuote(script)} | base64 -d | psql ${shellQuote(dbUrl)} -X -q -tA -v ON_ERROR_STOP=1`,
      { timeoutMs: 180_000 }
    );
    return result.ok
      ? { ok: true, report: parseProbeOutput(result.stdout) }
      : { ok: false, notes: describeFailure(result) };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}
