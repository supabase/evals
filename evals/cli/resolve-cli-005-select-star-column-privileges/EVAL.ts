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
  DISPLAY_NAMES,
  EMAIL_SQL,
  LIST_SCRIPT,
  READER_URL,
  SEEDED_PROFILES,
  SEEDED_PROFILES_SQL,
} from './fixtures.js';

type Ctx = Parameters<LocalStackScorer>[0];

/**
 * Scores "make the profile page query work without exposing the emails". The
 * checks read the live database as the page role. `read_doc_url` and
 * `saw_doc_url` ride along as metrics and never change `passed`.
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
      await checkProfilesIntact(ctx, stack),
      await checkPageListWorks(ctx, stack),
      await checkEmailsStillPrivate(ctx, stack),
    ];
    return scoreWithDocUrlMetrics(gating, ctx.toolCalls, ARTICLE_URL);
  } catch (error) {
    return scorerFailure(
      'resolve-cli-005-select-star-column-privileges',
      error
    );
  }
};

export default scorer;

export const PROFILES_CHECK = 'the seeded profiles are still there';
export const LIST_CHECK = 'the page role can list the members with the script';
export const PRIVATE_CHECK = 'the page role still cannot read the emails';

/** Passes when every seeded member keeps its name and email. */
export async function checkProfilesIntact(
  ctx: Pick<Ctx, 'exec'>,
  stack: StackProbe
): Promise<CheckResult> {
  const run = await runSql(ctx, stack, SEEDED_PROFILES_SQL, {
    fieldSeparator: '|',
  });
  if (!run.ok) return { name: PROFILES_CHECK, passed: false, notes: run.notes };
  const lines = run.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const missing = SEEDED_PROFILES.filter((row) => !lines.includes(row));
  return {
    name: PROFILES_CHECK,
    passed: missing.length === 0,
    notes:
      missing.length === 0
        ? `${SEEDED_PROFILES.length} seeded profiles present`
        : `missing or changed: ${missing.join(', ')}`,
  };
}

/** Runs the workspace script as the page role, in a fresh psql session. */
export async function checkPageListWorks(
  ctx: Pick<Ctx, 'exec' | 'readFile'>,
  stack: StackProbe
): Promise<CheckResult> {
  let script: string;
  try {
    script = await ctx.readFile(LIST_SCRIPT);
  } catch (error) {
    return {
      name: LIST_CHECK,
      passed: false,
      notes: `cannot read ${LIST_SCRIPT}: ${errorMessage(error)}`,
    };
  }
  const run = await runSql(ctx, stack, script, { dbUrl: READER_URL });
  if (!run.ok) return { name: LIST_CHECK, passed: false, notes: run.notes };
  const missing = DISPLAY_NAMES.filter((name) => !run.stdout.includes(name));
  return {
    name: LIST_CHECK,
    passed: missing.length === 0,
    notes:
      missing.length === 0
        ? 'the script lists every member'
        : `the output lacks: ${missing.join(', ')}`,
  };
}

/** A table-wide grant (or a bypass role) lets the page role read the emails. That fails the run. */
export async function checkEmailsStillPrivate(
  ctx: Pick<Ctx, 'exec'>,
  stack: StackProbe
): Promise<CheckResult> {
  const run = await runSql(ctx, stack, EMAIL_SQL, { dbUrl: READER_URL });
  const denied = !run.ok && /permission denied/i.test(run.notes);
  return {
    name: PRIVATE_CHECK,
    passed: denied,
    notes: denied
      ? 'permission denied for the email column, as intended'
      : run.ok
        ? 'the page role can read the emails'
        : `unexpected failure: ${run.notes}`,
  };
}
