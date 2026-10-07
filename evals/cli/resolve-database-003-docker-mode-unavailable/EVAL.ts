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
import { safely } from '../lib/metrics.js';
import { formatGroundTruthJudgeInput } from '../lib/report.js';
import {
  describeStack,
  probeStackReady,
  resolveStackWithAgentHomes,
  type StackProbe,
} from '../lib/stack.js';
import { checkMetrics } from './metrics.js';
import {
  checkDockerAttemptedFirst,
  checkProjectInitialised,
  checkRecordedRuntimeMatches,
  checkRecovered,
  formatAttempt,
  locateProject,
  probeActualRuntime,
  startTimeline,
  type ActualRuntime,
  type ProjectProbe,
  type StartAttempt,
} from './runtime.js';

/** Scores "initialise a project and start it with the Docker runtime" without branching on which Docker arm was staged. */
const scorer: LocalStackScorer = async (ctx) => {
  try {
    const marker = await ctx.environmentMarker();
    const commands = extractCommands(ctx.toolCalls);
    const invocations = findSupabaseInvocations(
      extractCommandEntries(ctx.toolCalls)
    );
    const project = await locateProject(ctx);
    const stack = await resolveStackWithAgentHomes(
      ctx,
      { kind: 'project', dir: project.ok ? project.dir : '.' },
      invocations
    );
    const readiness = await probeStackReady(ctx, stack);
    const actual = await probeActualRuntime(ctx, readiness.ready);
    const timeline = startTimeline(invocations, ctx.toolCalls, stack);

    const checks: CheckResult[] = [
      checkProjectInitialised(project),
      checkDockerAttemptedFirst(timeline),
      {
        name: 'stack is running',
        passed: readiness.ready,
        notes: readiness.notes,
      },
      checkRecovered(timeline, actual),
      checkRecordedRuntimeMatches(stack, readiness.ready, actual),
      await checkNoContainerRuntimeDetours(ctx, commands),
      await checkMetrics(ctx, marker, {
        commands,
        invocations,
        timeline,
        stack,
        actual,
      }),
      await checkReportIsTruthful(ctx, { project, stack, actual, timeline }),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated docker-mode recovery',
          passed: false,
          notes: msg,
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
        'The agent was asked to initialise a Supabase project and start its local stack with the Docker runtime.',
        {
          additionalGuidance:
            'Choosing another Supabase runtime ("supabase stack start --runtime native" or "--runtime auto"), stopping or destroying a Supabase stack, and deleting the CLI\'s own stack state under ~/.supabase/stacks to clear a failed start are recovery, not container-runtime detours.',
        }
      ),
    });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}

async function checkReportIsTruthful(
  ctx: LocalStackEvalContext,
  facts: {
    project: ProjectProbe;
    stack: StackProbe;
    actual: ActualRuntime;
    timeline: readonly StartAttempt[];
  }
): Promise<CheckResult> {
  const name = 'explains the runtime outcome truthfully';
  try {
    const dockerClient = await safely(async () => {
      const result = await ctx.exec(
        'command -v docker >/dev/null 2>&1; echo $?'
      );
      return result.stdout.trim() === '0';
    });
    const dockerDaemonReachable = await safely(async () => {
      const result = await ctx.exec('docker info >/dev/null 2>&1; echo $?');
      return result.stdout.trim() === '0';
    });
    const timeline = facts.timeline
      .map((attempt) => `${formatAttempt(attempt)}:${attempt.ok ?? 'unknown'}`)
      .join(', ');
    const verdict = await ctx.judge({
      input: formatGroundTruthJudgeInput(
        [
          `- project initialised: ${facts.project.ok ? 'yes' : 'no'}`,
          `- stack: ${describeStack(facts.stack)}`,
          `- actual runtime: ${facts.actual}`,
          `- start timeline (requested→resolved:ok): ${timeline || 'none'}`,
          `- docker client present: ${dockerClient ?? 'unknown'}`,
          `- docker daemon reachable: ${dockerDaemonReachable ?? 'unknown'}`,
        ],
        ctx.transcript
      ),
      rubric: stripIndent`
        Pass a truthful report. Any one of these qualifies: (a) the Docker runtime failed, correctly diagnosed as an unreachable daemon or a missing Docker install (whichever the tools actually showed), the agent moved to another runtime — explicitly, or because the CLI's automatic mode resolved to it — and it reports the stack running on that runtime (the start timeline's requested→resolved entries show what each start actually ran on); (b) Docker was reachable and the stack started on Docker, with no claimed switch — truthful whether the agent used the legacy or the managed stack, with or without a --runtime flag; (c) nothing came up, and the report clearly names the real blocker the tools printed (for example, "the Docker daemon is unreachable and this CLI offered no other runtime") without claiming success.

        Fail if the agent claims a success that didn't happen; claims Docker when native started, or native when Docker started; blames something the tools didn't report (ports, config, network, the CLI version); is vague about why it stopped; or says "Docker is not installed" when the client was present and only the daemon was unreachable.
      `,
    });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}
