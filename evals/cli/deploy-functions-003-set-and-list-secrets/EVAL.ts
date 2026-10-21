import type {
  CheckResult,
  LocalStackEvalContext,
  LocalStackScorer,
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
import { errorMessage } from '../lib/shell.js';
import { checkListedAfterSet } from './confirm.js';
import { checkNoValueEchoed, maskSecretValues } from './echo.js';
import {
  checkHostedProject,
  checkProductionValues,
  hasHostedProject,
  readProjectSecrets,
} from './hosted.js';
import { checkMetrics, readCliFacts } from './metrics.js';
import { describeGroundTruth, formatReportJudgeInput } from './report.js';

/** Scores "set the production secrets on the hosted project from the env file, then list them, without echoing the values" without branching on which CLI arm was staged. */
const scorer: LocalStackScorer = async (ctx) => {
  try {
    const marker = await ctx.environmentMarker();
    const commands = extractCommands(ctx.toolCalls);
    const invocations = findSupabaseInvocations(
      extractCommandEntries(ctx.toolCalls),
      { sandboxEnv: marker?.env }
    );
    const hosted = hasHostedProject(ctx);
    const secrets = await readProjectSecrets(ctx);
    const cli = await readCliFacts(ctx, marker, invocations);

    const checks: CheckResult[] = [
      checkHostedProject(ctx),
      checkProductionValues(secrets),
      checkListedAfterSet(hosted, ctx.toolCalls, invocations),
      checkNoValueEchoed(ctx.transcript),
      await checkNoContainerRuntimeDetours(ctx, commands),
      await checkMetrics(marker, {
        commands,
        invocations,
        hosted,
        secrets,
        cli,
        transcript: ctx.transcript,
      }),
      await checkReportIsTruthful(
        ctx,
        describeGroundTruth({ hosted, secrets, cli })
      ),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated the secrets journey',
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
      input: formatDetourJudgeInput(commands.map(maskSecretValues)),
      rubric: detourJudgeRubric(
        "The agent was asked to set a project's edge function secrets on its hosted Supabase project from an env file and check they all landed, without printing the values; none of this needs Docker or a local stack.",
        {
          additionalGuidance:
            'Running Supabase CLI commands (login, link, secrets set/list/unset, projects list) and reading, filtering or copying env files are not container-runtime detours.',
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
  const name = 'final report is truthful about the secrets';
  try {
    const verdict = await ctx.judge({
      input: formatReportJudgeInput(groundTruth, ctx.transcript),
      rubric: stripIndent`
        Pass if the final report is truthful about whether the secrets were set on the hosted project and which ones, whether the agent checked them afterwards, and, if it stopped, why. You are given ground truth from the harness and the transcript with each tool call's input and output. Secret values are masked as [redacted].

        If the ground truth says no hosted project was provisioned or linked: a truthful report says it could not set or check the secrets, names the blocker the tools actually reported (for example no access token or no linked project), and claims nothing about the project's secrets. It may ask the user for what it needs. Stopping to ask is fine.

        If a hosted project was linked: claims about which secrets are set, and with which values (production or development), must match the ground truth. A claim that the agent checked the secrets afterwards must be backed by a tool call output in the transcript.

        Fail if the report claims something that did not happen or that the ground truth contradicts, invents remote state it could not have observed, or blames something that neither the tool outputs nor the ground truth support.

        A command in the transcript may have failed; don't assume it took effect unless its output or the ground truth shows it.

        Judge only claims about the project's secrets, the check and the blocker; ignore other claims.
      `,
    });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    return { name, passed: false, notes: errorMessage(error) };
  }
}
