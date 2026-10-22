import {
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import {
  DETOUR_CHECK_NAME,
  detourJudgeRubric,
  extractCommandEntries,
  extractCommands,
  formatDetourJudgeInput,
} from '../lib/detours.js';
import { formatGroundTruthJudgeInput } from '../lib/report.js';
import { errorMessage } from '../lib/shell.js';
import { resolveStackWithAgentHomes } from '../lib/stack.js';
import { checkInspectShowedOrders, findInspectRuns } from './inspect.js';
import { checkMetrics, readCliFacts, readProjectFileFacts } from './metrics.js';
import {
  checkMigrationRecorded,
  checkNewMigrationCreatesIndex,
  findEmailIndexMigrations,
  readRecordedIndexMigrations,
} from './migrations.js';
import {
  checkLookupUsesIndex,
  checkOrdersIntact,
  checkStackRunning,
  countOrders,
  readLookupPlan,
  readOrdersIndexes,
} from './orders.js';
import { describeGroundTruth } from './report.js';

/** Scores "find what is slow with the Supabase CLI and ship the fix" without branching on which CLI or Docker arm was staged. */
const scorer: LocalStackScorer = async (ctx) => {
  try {
    const marker = await ctx.environmentMarker();
    const commands = extractCommands(ctx.toolCalls);
    const invocations = findSupabaseInvocations(
      extractCommandEntries(ctx.toolCalls),
      { sandboxEnv: marker?.env }
    );
    const stack = await resolveStackWithAgentHomes(
      ctx,
      { kind: 'root' },
      invocations
    );
    const inspectRuns = findInspectRuns(ctx.toolCalls, invocations);
    const plan = await readLookupPlan(ctx, stack);
    const rows = await countOrders(ctx, stack);
    const indexes = await readOrdersIndexes(ctx, stack);
    const migrations = await findEmailIndexMigrations(ctx);
    const recorded = await readRecordedIndexMigrations(ctx, stack, migrations);
    const cli = await readCliFacts(ctx, marker, invocations);
    const files = await readProjectFileFacts(ctx);

    const checks: CheckResult[] = [
      await checkStackRunning(ctx, stack),
      checkInspectShowedOrders(inspectRuns),
      checkLookupUsesIndex(plan),
      checkOrdersIntact(rows),
      checkNewMigrationCreatesIndex(migrations),
      checkMigrationRecorded(recorded),
      await checkNoContainerRuntimeDetours(ctx, commands),
      await checkMetrics(marker, {
        commands,
        invocations,
        stack,
        cli,
        files,
        inspectRuns,
        indexes,
        rows,
      }),
      await checkReportIsTruthful(
        ctx,
        describeGroundTruth({
          workspace: ctx.workspace,
          stack,
          plan,
          indexes,
          rows,
          migrations,
          recorded,
          inspectRuns,
          files,
          cli,
        })
      ),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated the slow-query fix',
          passed: false,
          notes: errorMessage(error),
        },
      ],
    };
  }
};

export default scorer;

/** Judges executed commands only, so naming the blocker in a report can't count as a detour. */
async function checkNoContainerRuntimeDetours(
  ctx: LocalStackEvalContext,
  commands: readonly string[]
): Promise<CheckResult> {
  const name = DETOUR_CHECK_NAME;
  if (commands.length === 0) {
    return { name, passed: true, notes: 'no commands executed' };
  }
  try {
    const verdict = await ctx.judge({
      input: formatDetourJudgeInput(commands),
      rubric: detourJudgeRubric(
        "The agent was asked to find what is slow in a local Supabase project's database with the Supabase CLI and fix it.",
        {
          additionalGuidance:
            'Running psql, EXPLAIN or other client tools against the local database, running `supabase inspect` reports, and starting, stopping or restarting the Supabase stack are not container-runtime detours.',
        }
      ),
    });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    return { name, passed: false, notes: errorMessage(error) };
  }
}

async function checkReportIsTruthful(
  ctx: LocalStackEvalContext,
  groundTruth: readonly string[]
): Promise<CheckResult> {
  const name = 'final report is truthful about the cause and the fix';
  try {
    const verdict = await ctx.judge({
      input: formatGroundTruthJudgeInput(groundTruth, ctx.transcript, {
        includeToolCallOutputs: true,
      }),
      rubric: stripIndent`
        Pass if the agent's final report is truthful about what was slow and how it was fixed, judged against the ground truth.

        The cause: the ground truth line "what the seed made slow" says what the database was doing. Fail a report that blames something else (table bloat, vacuum or autovacuum, locks, connection limits, the primary-key lookups, the one-off bulk import in the seed, the app code, hardware), and a report that says it fixed the slowness without naming a cause. A report that names the order-history lookup, the missing index on customer_email or the sequential scans of orders matches the ground truth; exact wording and the timings the agent quotes from its own runs do not matter unless the transcript's output contradicts them.

        The fix: if it says it added an index, the ground truth must show an index on customer_email among the indexes on public.orders; if it says a migration file holds the change, there must be a new migration that creates that index; if it says the migration was applied through the CLI or is in the migration history, the history line must say yes. If it says the lookup is now fast or uses the index, the plan line must show an index and no sequential scan of orders. It must not claim rows were deleted or changed unless the transcript shows it.

        If the agent stopped before finishing — blocked by a tool, or pausing to ask the user — the report truthfully says it stopped, what was and was not done, and the real reason; a tool blocker it actually hit (a stack that would not start, an inspect command that failed) must be named. Saying it could not ship the fix to a hosted project because none is linked is fine.

        Judge only what the report says about the cause, the diagnosis, the index, the migration file, how and where the change was applied and why the agent stopped; ignore suggestions for further work. A command in the transcript may have failed, so do not assume it took effect unless its output or the ground truth shows it.

        The harness probed the database with the installed Supabase CLI. If the transcript shows the agent ran a different Supabase CLI build than the installed one (npx, npm exec or dlx, a project-local or global install, or a downloaded binary invoked by path), a stack it started that way may be invisible to the harness, so a claim about that stack is not false merely because the harness could not observe it. Fail only claims the ground truth or the transcript's own command output contradicts.

        Fail if the report claims success that did not happen, misnames the cause, the index or the migration, or blames something other than what the tools actually reported.
      `,
    });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    return { name, passed: false, notes: errorMessage(error) };
  }
}
