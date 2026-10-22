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
import { formatGroundTruthJudgeInput } from '../lib/report.js';
import { errorMessage } from '../lib/shell.js';
import {
  probeStackReady,
  resolveStackWithAgentHomes,
  type StackProbe,
} from '../lib/stack.js';
import {
  ADVISORS_CHECK,
  BEHAVIOUR_CHECK,
  checkAdvisorsClean,
  checkAppBehaviour,
  checkLintClean,
  checkReplay,
  LINT_CHECK,
  REPLAY_CHECK,
} from './checks.js';
import { checkRanDatabaseChecks, countDatabaseCheckRuns } from './commands.js';
import { APP_READERS } from './fixtures.js';
import { checkHistoryRecordsFiles, HISTORY_CHECK } from './history.js';
import { checkMetrics, readCliFacts } from './metrics.js';
import { type ProbeReport, type ProbeResult, runProbe } from './probe.js';
import { describeGroundTruth, REPORT_CHECK, REPORT_RUBRIC } from './report.js';
import {
  readWorkspaceSql,
  replayFiles,
  type WorkspaceSql,
} from './workspace.js';

/** Scores "run the database checks on the local database and fix what they flag" without branching on which CLI or Docker arm was staged. */
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
    const migrations = await readWorkspaceSql(ctx);
    const probe = await probeDatabase(ctx, stack, migrations);
    const counts = countDatabaseCheckRuns(invocations);
    const cli = await readCliFacts(ctx, marker, invocations);
    const history = checkHistory(migrations, probe);

    const checks: CheckResult[] = [
      await checkStackRunning(ctx, stack),
      checkRanDatabaseChecks(counts),
      scoreProbe(probe, LINT_CHECK, ({ live }) => checkLintClean(live)),
      scoreProbe(probe, ADVISORS_CHECK, ({ live }) => checkAdvisorsClean(live)),
      scoreProbe(probe, BEHAVIOUR_CHECK, ({ live }) => checkAppBehaviour(live)),
      history,
      scoreProbe(probe, REPLAY_CHECK, checkReplay),
      await checkNoContainerRuntimeDetours(ctx, commands),
      await checkMetrics(marker, {
        commands,
        invocations,
        stack,
        cli,
        migrations,
        probe,
      }),
      await checkReportIsTruthful(
        ctx,
        describeGroundTruth({
          stack,
          probe,
          migrations,
          history,
          counts,
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
          name: 'scorer evaluated resolve-database-005-fix-lint-findings',
          passed: false,
          notes: errorMessage(error),
        },
      ],
    };
  }
};

export default scorer;

async function probeDatabase(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  stack: StackProbe,
  sql: WorkspaceSql
): Promise<ProbeResult> {
  if (!stack.ok) return { ok: false, notes: stack.notes };
  if (!sql.ok) return { ok: false, notes: sql.notes };
  return runProbe(
    ctx,
    stack.dbUrl,
    replayFiles(sql),
    APP_READERS.map(({ sub }) => sub)
  );
}

function scoreProbe(
  probe: ProbeResult,
  name: string,
  score: (report: ProbeReport) => CheckResult
): CheckResult {
  return probe.ok
    ? score(probe.report)
    : { name, passed: false, notes: probe.notes };
}

function checkHistory(
  migrations: WorkspaceSql,
  probe: ProbeResult
): CheckResult {
  if (!migrations.ok) {
    return { name: HISTORY_CHECK, passed: false, notes: migrations.notes };
  }
  return scoreProbe(probe, HISTORY_CHECK, ({ history }) =>
    checkHistoryRecordsFiles(migrations.migrations, history)
  );
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
        "The agent was asked to run Supabase's database checks on a project's local database and fix whatever they flag.",
        {
          additionalGuidance:
            'Running Supabase CLI commands (start, stop, status, db lint, db advisors, db reset, db query, db diff, migration new, up or list), psql or other database clients, and reading or editing files under supabase/ are not container-runtime detours.',
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
