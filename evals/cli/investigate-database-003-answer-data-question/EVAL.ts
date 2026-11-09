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
import {
  probeStackReady,
  resolveStackWithAgentHomes,
  type StackProbe,
} from '../lib/stack.js';
import {
  ANSWER_SOURCE_CHECK,
  checkReplyGivesCount,
  type DbQueryRun,
  finalReply,
  findDbQueryRuns,
  findSavedOutputReads,
  formatAnswerSourceJudgeInput,
  gateAnswerSource,
  type SavedOutputRead,
} from './answer.js';
import { checkSeededDataUnchanged, readSeededData } from './data.js';
import { FALLBACK_CHECK, FALLBACK_RUBRIC } from './fallback.js';
import { SEEDED } from './fixtures.js';
import { checkMetrics, readCliFacts } from './metrics.js';
import { describeGroundTruth, REPORT_CHECK, REPORT_RUBRIC } from './report.js';

/** Scores "answer a data question about the local database with the Supabase CLI" without branching on which CLI or Docker arm was staged. */
const scorer: LocalStackScorer = async (ctx) => {
  try {
    const marker = await ctx.environmentMarker();
    const commands = extractCommands(ctx.toolCalls);
    const invocations = findSupabaseInvocations(
      extractCommandEntries(ctx.toolCalls),
      { sandboxEnv: marker?.env }
    );
    const runs = findDbQueryRuns(ctx.toolCalls, invocations);
    const reads = findSavedOutputReads(ctx.toolCalls, runs);
    const stack = await resolveStackWithAgentHomes(
      ctx,
      { kind: 'root' },
      invocations
    );
    const data = await readSeededData(ctx, stack);
    const cli = await readCliFacts(ctx, marker, invocations);
    const reply = finalReply(ctx.transcript);

    const checks: CheckResult[] = [
      await checkStackRunning(ctx, stack),
      checkSeededDataUnchanged(data),
      await checkAnswerSource(ctx, runs, reads),
      await checkNoFallback(ctx, commands),
      checkReplyGivesCount(reply),
      await checkNoContainerRuntimeDetours(ctx, commands),
      await checkMetrics(marker, {
        commands,
        invocations,
        stack,
        cli,
        dbQueryRuns: runs,
        savedOutputReads: reads,
        reply,
      }),
      await checkReportIsTruthful(
        ctx,
        describeGroundTruth({
          workspace: ctx.workspace,
          stack,
          data,
          dbQueryRuns: runs,
          savedOutputReads: reads,
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
          name: 'scorer evaluated investigate-database-003-answer-data-question',
          passed: false,
          notes: errorMessage(error),
        },
      ],
    };
  }
};

export default scorer;

async function checkStackRunning(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  stack: StackProbe
): Promise<CheckResult> {
  const { ready, notes } = await probeStackReady(ctx, stack);
  return {
    name: 'local stack is running for this project',
    passed: ready,
    notes,
  };
}

/** Gates on the db query output and on later calls that read what it saved, then has the judge decide when they only printed part of the answer. */
async function checkAnswerSource(
  ctx: LocalStackEvalContext,
  runs: readonly DbQueryRun[],
  reads: readonly SavedOutputRead[]
): Promise<CheckResult> {
  const gated = gateAnswerSource(runs, reads);
  if (gated !== undefined) return gated;
  const name = ANSWER_SOURCE_CHECK;
  try {
    const verdict = await ctx.judge({
      input: formatAnswerSourceJudgeInput(runs, reads),
      rubric: stripIndent`
        The agent was asked how many customers of a local Supabase project have never placed an order, using the Supabase CLI. The right answer is ${SEEDED.neverOrdered}. Below are the supabase db query runs the harness found, each with its full command and output, followed by the later tool calls that name a file one of those runs saved (a redirect or tee target), labelled with the file and the run.

        Pass only if the output of these calls gives ${SEEDED.neverOrdered} directly or by simple arithmetic on numbers they printed (for example a customer total minus a count of customers with orders). Every number the arithmetic uses must appear in the output of these calls; a number from the seed file, the agent's own messages or any other tool does not count. A number printed by a listed call that processes a file a db query run saved (jq, awk, wc, a short script over that file) counts the same as the run's own output. A number printed by another command in the same tool call (echo, printf, shell arithmetic, a file the agent wrote earlier), or typed into the SQL as a literal, does not count. A number from psql or any other database client does not count, even if the db query ran a trivial statement.
      `,
    });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    return { name, passed: false, notes: errorMessage(error) };
  }
}

async function checkNoFallback(
  ctx: LocalStackEvalContext,
  commands: readonly string[]
): Promise<CheckResult> {
  const name = FALLBACK_CHECK;
  if (commands.length === 0) {
    return { name, passed: true, notes: 'no commands executed' };
  }
  try {
    const verdict = await ctx.judge({
      input: formatDetourJudgeInput(commands),
      rubric: FALLBACK_RUBRIC,
    });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    return { name, passed: false, notes: errorMessage(error) };
  }
}

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
        "The agent was asked to answer a data question about a local Supabase project's database with the Supabase CLI.",
        {
          additionalGuidance:
            'Running Supabase CLI commands, psql or other clients at the local database, and reading project files are not container-runtime detours.',
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
  const name = REPORT_CHECK;
  try {
    const verdict = await ctx.judge({
      input: formatGroundTruthJudgeInput(groundTruth, ctx.transcript, {
        includeToolCallOutputs: true,
      }),
      rubric: REPORT_RUBRIC,
    });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    return { name, passed: false, notes: errorMessage(error) };
  }
}
