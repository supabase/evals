import {
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import {
  DETOUR_CHECK_NAME,
  detourJudgeRubric,
  extractCommandEntries,
  extractCommands,
  formatDetourJudgeInput,
} from '../lib/detours.js';
import { findTestDbRuns } from '../lib/pgtap.js';
import { formatGroundTruthJudgeInput } from '../lib/report.js';
import { errorMessage } from '../lib/shell.js';
import {
  probeStackReady,
  resolveStackWithAgentHomes,
  type StackProbe,
} from '../lib/stack.js';
import { SEEDED_TEST_FILES } from './fixtures.js';
import {
  checkHistoryMatchesFiles,
  HISTORY_CHECK,
  type HistoryProbe,
  readMigrationHistory,
} from './history.js';
import { checkMetrics, readCliFacts } from './metrics.js';
import { checkReplay, type ReplayResult, replayMigrations } from './replay.js';
import { describeGroundTruth, REPORT_CHECK, REPORT_RUBRIC } from './report.js';
import {
  checkSeededTestsPass,
  LIVE_TESTS_CHECK,
  runSeededSuite,
  type SuiteRun,
} from './suite.js';
import { checkSuitePassedUnderTestDb } from './test-db.js';
import {
  checkSeededTestsUnchanged,
  readWorkspace,
  type WorkspaceProbe,
} from './workspace.js';

/** Scores "work out why the database tests fail, fix it and leave the database running" without branching on which CLI or Docker arm was staged. */
const scorer: LocalStackScorer = async (ctx) => {
  try {
    const marker = await ctx.environmentMarker();
    const commands = extractCommands(ctx.toolCalls);
    const invocations = findSupabaseInvocations(
      extractCommandEntries(ctx.toolCalls),
      { sandboxEnv: marker?.env }
    );
    const testDbRuns = findTestDbRuns(ctx.toolCalls, invocations);
    const stack = await resolveStackWithAgentHomes(
      ctx,
      { kind: 'root' },
      invocations
    );
    const workspace = await readWorkspace(ctx);
    const live: SuiteRun = stack.ok
      ? await runSeededSuite(ctx, stack.dbUrl)
      : { ok: false, notes: stack.notes };
    const history: HistoryProbe = stack.ok
      ? await readMigrationHistory(ctx, stack.dbUrl)
      : { ok: false, notes: stack.notes };
    const replay = await replayWorkspace(ctx, stack, workspace);
    const cli = await readCliFacts(ctx, marker, invocations);

    const liveCheck = checkSeededTestsPass(LIVE_TESTS_CHECK, live);
    const replayCheck = checkReplay(replay);
    const historyCheck = checkHistory(workspace, history);
    const testsUnchanged = checkSeededTestsUnchanged(workspace);

    const checks: CheckResult[] = [
      await checkStackRunning(ctx, stack),
      checkSuitePassedUnderTestDb(testDbRuns, SEEDED_TEST_FILES.length),
      liveCheck,
      replayCheck,
      historyCheck,
      testsUnchanged,
      await checkNoContainerRuntimeDetours(ctx, commands),
      await checkMetrics(marker, {
        commands,
        invocations,
        stack,
        cli,
        workspace,
        testDbRuns,
      }),
      await checkReportIsTruthful(
        ctx,
        describeGroundTruth({
          directory: ctx.workspace,
          stack,
          cli,
          workspace,
          live: liveCheck,
          replay: replayCheck,
          history: historyCheck,
          testsUnchanged,
          testDbRuns,
        })
      ),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated resolve-database-006-fix-failing-pgtap-suite',
          passed: false,
          notes: errorMessage(error),
        },
      ],
    };
  }
};

export default scorer;

async function replayWorkspace(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  stack: StackProbe,
  workspace: WorkspaceProbe
): Promise<ReplayResult> {
  if (!stack.ok) return { ok: false, notes: stack.notes };
  if (!workspace.ok) return { ok: false, notes: workspace.notes };
  return replayMigrations(
    ctx,
    stack.dbUrl,
    workspace.migrations.map(({ name }) => name)
  );
}

function checkHistory(
  workspace: WorkspaceProbe,
  history: HistoryProbe
): CheckResult {
  return workspace.ok
    ? checkHistoryMatchesFiles(workspace.migrations, history)
    : { name: HISTORY_CHECK, passed: false, notes: workspace.notes };
}

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
        'The agent was asked to work out why the database tests of a Supabase project fail, fix the cause and leave the local database running.',
        {
          additionalGuidance:
            'Running Supabase CLI commands (start, db reset, migration up, test db), psql or pg_prove against the local database, and reading or editing files under supabase/ are not container-runtime detours.',
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
