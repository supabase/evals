import type { CheckResult, LocalStackScorer } from '@supabase-evals/core';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import { extractCommandEntries } from '../lib/detours.js';
import {
  checkStackRunning,
  runSql,
  scoreWithDocUrlMetrics,
  scorerFailure,
} from '../lib/docurl.js';
import { errorMessage } from '../lib/shell.js';
import { resolveStackWithAgentHomes, type StackProbe } from '../lib/stack.js';
import {
  ARTICLE_URL,
  REGISTER_SCRIPT,
  readSeedFile,
  registerInRolledBackTransaction,
  SEEDED_ASSETS,
  SEEDED_ASSETS_SQL,
} from './fixtures.js';

type Ctx = Parameters<LocalStackScorer>[0];

/**
 * Scores "make the registration script work, unchanged". The checks read the
 * live database in fresh psql sessions. `read_doc_url` and `saw_doc_url` ride
 * along as metrics and never change `passed`.
 */
const scorer: LocalStackScorer = async (ctx) => {
  try {
    const marker = await ctx.environmentMarker();
    const invocations = findSupabaseInvocations(
      extractCommandEntries(ctx.toolCalls),
      { sandboxEnv: marker?.env }
    );
    const stack = await resolveStackWithAgentHomes(
      ctx,
      { kind: 'root' },
      invocations
    );
    const gating: CheckResult[] = [
      await checkStackRunning(ctx, stack),
      await checkAssetsIntact(ctx, stack),
      await checkScriptUnchanged(ctx),
      await checkRegistrationWorks(ctx, stack),
    ];
    return scoreWithDocUrlMetrics(gating, ctx.toolCalls, ARTICLE_URL);
  } catch (error) {
    return scorerFailure('resolve-cli-006-null-byte-string-literal', error);
  }
};

export default scorer;

export const ASSETS_CHECK = 'the seeded asset is still there';
export const UNCHANGED_CHECK = 'the registration script is unchanged';
export const REGISTER_CHECK =
  'the script registers the path with its backslashes as written';

/** Passes when the seeded asset keeps its id, path and label. */
export async function checkAssetsIntact(
  ctx: Pick<Ctx, 'exec'>,
  stack: StackProbe
): Promise<CheckResult> {
  const run = await runSql(ctx, stack, SEEDED_ASSETS_SQL, {
    fieldSeparator: '|',
  });
  if (!run.ok) return { name: ASSETS_CHECK, passed: false, notes: run.notes };
  const lines = run.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const missing = SEEDED_ASSETS.filter((row) => !lines.includes(row));
  return {
    name: ASSETS_CHECK,
    passed: missing.length === 0,
    notes:
      missing.length === 0
        ? 'the seeded asset is present'
        : `missing or changed: ${missing.join(', ')}`,
  };
}

/** The importer regenerates the script, so a fix that edits it does not count. */
export async function checkScriptUnchanged(
  ctx: Pick<Ctx, 'readFile'>
): Promise<CheckResult> {
  try {
    const current = await ctx.readFile(REGISTER_SCRIPT);
    const passed = current === readSeedFile(REGISTER_SCRIPT);
    return {
      name: UNCHANGED_CHECK,
      passed,
      notes: passed ? undefined : `${REGISTER_SCRIPT} was edited`,
    };
  } catch (error) {
    return {
      name: UNCHANGED_CHECK,
      passed: false,
      notes: `cannot read ${REGISTER_SCRIPT}: ${errorMessage(error)}`,
    };
  }
}

/**
 * Runs the script in a fresh psql session inside a transaction that is rolled
 * back, then compares the stored path with the literal text.
 */
export async function checkRegistrationWorks(
  ctx: Pick<Ctx, 'exec' | 'readFile'>,
  stack: StackProbe
): Promise<CheckResult> {
  let script: string;
  try {
    script = await ctx.readFile(REGISTER_SCRIPT);
  } catch (error) {
    return {
      name: REGISTER_CHECK,
      passed: false,
      notes: `cannot read ${REGISTER_SCRIPT}: ${errorMessage(error)}`,
    };
  }
  const run = await runSql(ctx, stack, registerInRolledBackTransaction(script));
  if (!run.ok) return { name: REGISTER_CHECK, passed: false, notes: run.notes };
  const lines = run.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const stored = lines.at(-1) === 't';
  return {
    name: REGISTER_CHECK,
    passed: stored,
    notes: stored
      ? 'the insert succeeded and kept the backslashes'
      : `the stored path differs from the script text (${lines.at(-1) ?? 'no output'})`,
  };
}
