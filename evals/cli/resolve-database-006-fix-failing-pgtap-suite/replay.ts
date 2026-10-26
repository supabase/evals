import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { describeFailure, errorMessage, shellQuote } from '../lib/shell.js';
import { MIGRATIONS_DIR, REPLAY_DATABASE } from './fixtures.js';
import { psqlCommand, readPsqlError, withDatabase } from './sql.js';
import {
  checkSeededTestsPass,
  runSeededSuite,
  type SuiteRun,
} from './suite.js';

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;

export type ReplayResult =
  | { ok: true; applied: string[]; suite: SuiteRun }
  | { ok: false; notes: string };

export const REPLAY_CHECK =
  'the seeded tests pass on a database rebuilt from the migrations';

const MIGRATIONS_TIMEOUT_MS = 180_000;
const DROP_REPLAY = `-c "drop database if exists ${REPLAY_DATABASE} with (force)"`;
const CREATE_REPLAY = `-c "create database ${REPLAY_DATABASE}"`;
const CREATE_EXTENSIONS_SCHEMA = '-c "create schema if not exists extensions"';

/** Applies the migration files, in the order given, to a scratch database on the stack's server, runs the seeded tests there and drops it. */
export async function replayMigrations(
  ctx: ExecContext,
  liveUrl: string,
  files: readonly string[]
): Promise<ReplayResult> {
  if (files.length === 0) {
    return { ok: false, notes: 'no migration files to replay' };
  }
  try {
    const replayUrl = withDatabase(liveUrl, REPLAY_DATABASE);
    const created = await ctx.exec(
      psqlCommand(liveUrl, `${DROP_REPLAY} ${CREATE_REPLAY}`)
    );
    if (!created.ok) {
      return {
        ok: false,
        notes: `could not create the scratch database: ${describeFailure(created)}`,
      };
    }
    const prepared = await ctx.exec(
      psqlCommand(replayUrl, CREATE_EXTENSIONS_SCHEMA)
    );
    if (!prepared.ok) {
      return {
        ok: false,
        notes: `could not prepare the scratch database: ${describeFailure(prepared)}`,
      };
    }
    const applied = await ctx.exec(
      psqlCommand(
        replayUrl,
        files
          .map((file) => `-f ${shellQuote(`${MIGRATIONS_DIR}/${file}`)}`)
          .join(' ')
      ),
      { timeoutMs: MIGRATIONS_TIMEOUT_MS }
    );
    if (!applied.ok) {
      return {
        ok: false,
        notes: `replaying the migrations stopped: ${readPsqlError(applied.stderr) ?? describeFailure(applied)}`,
      };
    }
    return {
      ok: true,
      applied: [...files],
      suite: await runSeededSuite(ctx, replayUrl),
    };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  } finally {
    // A failed cleanup must not change the verdict.
    await ctx.exec(psqlCommand(liveUrl, DROP_REPLAY)).catch(() => undefined);
  }
}

/** Passes when every migration file applied and the seeded tests pass on the rebuilt database. */
export function checkReplay(result: ReplayResult): CheckResult {
  const name = REPLAY_CHECK;
  if (!result.ok) return { name, passed: false, notes: result.notes };
  const suite = checkSeededTestsPass(name, result.suite);
  return {
    name,
    passed: suite.passed,
    notes: `${result.applied.length} migration(s) replayed; ${suite.notes}`,
  };
}
