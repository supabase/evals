import type {
  CheckResult,
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describeTapFailures, parseTap, tapPassed } from '../lib/pgtap.js';
import { describeFailure, errorMessage, shellQuote } from '../lib/shell.js';
import { SEEDED_TESTS } from './fixtures.js';
import { psqlCommand, readPsqlError } from './sql.js';

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;

export type SuiteFileRun = {
  file: string;
  exitCode: number | null;
  passed: boolean;
  planned: number | null;
  ran: number;
  failures: string[];
  error?: string;
};

export type SuiteRun =
  | { ok: true; files: SuiteFileRun[] }
  | { ok: false; notes: string };

export const LIVE_TESTS_CHECK =
  'the seeded tests pass against the local database';

const FILE_TIMEOUT_MS = 120_000;
const PGTAP_INSTALLED = `-c "select exists (select 1 from pg_extension where extname = 'pgtap')"`;
const INSTALL_PGTAP =
  '-c "create schema if not exists extensions" -c "create extension if not exists pgtap with schema extensions"';
const REMOVE_PGTAP = '-c "drop extension if exists pgtap"';

const pgtapUnavailable = (result: CommandResult): SuiteRun => ({
  ok: false,
  notes: `could not prepare pgTAP: ${describeFailure(result)}`,
});

async function runTestFile(
  ctx: ExecContext,
  dbUrl: string,
  { file, sql }: (typeof SEEDED_TESTS)[number]
): Promise<SuiteFileRun> {
  const encoded = Buffer.from(sql, 'utf8').toString('base64');
  const result = await ctx.exec(
    `printf '%s' ${shellQuote(encoded)} | base64 -d | ${psqlCommand(dbUrl, '-f -')}`,
    { timeoutMs: FILE_TIMEOUT_MS }
  );
  const tap = parseTap(result.stdout);
  const error =
    result.exitCode === 0 ? undefined : readPsqlError(result.stderr);
  return {
    file,
    exitCode: result.exitCode,
    passed: tapPassed(result.exitCode, tap),
    planned: tap.planned,
    ran: tap.results.length,
    failures: describeTapFailures(result.stdout),
    ...(error === undefined ? {} : { error }),
  };
}

/** Runs the pristine seeded tests against `dbUrl` one file at a time, as `pg_prove` does, installing pgTAP for the run when the database lacks it. */
export async function runSeededSuite(
  ctx: ExecContext,
  dbUrl: string
): Promise<SuiteRun> {
  try {
    const installed = await ctx.exec(psqlCommand(dbUrl, PGTAP_INSTALLED));
    if (!installed.ok) return pgtapUnavailable(installed);
    const hadPgtap = installed.stdout.trim() === 't';
    if (!hadPgtap) {
      const created = await ctx.exec(psqlCommand(dbUrl, INSTALL_PGTAP));
      if (!created.ok) return pgtapUnavailable(created);
    }
    try {
      const files: SuiteFileRun[] = [];
      for (const test of SEEDED_TESTS) {
        files.push(await runTestFile(ctx, dbUrl, test));
      }
      return { ok: true, files };
    } finally {
      if (!hadPgtap) {
        // A failed cleanup must not change the verdict.
        await ctx.exec(psqlCommand(dbUrl, REMOVE_PGTAP)).catch(() => undefined);
      }
    }
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

function describeFile(run: SuiteFileRun): string {
  const planned = run.planned ?? '?';
  if (run.passed) return `${run.file}: ${run.ran}/${planned} passed`;
  const problems = [
    ...run.failures,
    ...(run.error === undefined
      ? []
      : [`stopped after ${run.ran} of ${planned} tests: ${run.error}`]),
  ];
  return `${run.file}: ${
    problems.length > 0
      ? problems.join('; ')
      : `ran ${run.ran} of ${planned} tests`
  }`;
}

/** Passes when the suite ran and every seeded test file passed. */
export function checkSeededTestsPass(name: string, run: SuiteRun): CheckResult {
  if (!run.ok) return { name, passed: false, notes: run.notes };
  return {
    name,
    passed: run.files.every(({ passed }) => passed),
    notes: run.files.map(describeFile).join('; '),
  };
}
