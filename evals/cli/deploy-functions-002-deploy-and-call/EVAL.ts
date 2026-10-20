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
import {
  checkFunctionDeployed,
  checkHostedProject,
  checkJwtVerificationKept,
  type DeploymentProbe,
  hasHostedProject,
  NO_HOSTED_PROJECT,
  readDeployment,
} from './hosted.js';
import { checkMetrics, readCliFacts } from './metrics.js';
import { describeGroundTruth, formatReportJudgeInput } from './report.js';
import { checkQuotesAnswered, probeQuotes } from './responses.js';
import {
  describeVerificationFacts,
  formatVerificationJudgeInput,
} from './verification.js';

/** Scores "deploy an edge function to the hosted project and confirm the live function responds" without branching on which CLI or Docker arm was staged. */
const scorer: LocalStackScorer = async (ctx) => {
  try {
    const marker = await ctx.environmentMarker();
    const commands = extractCommands(ctx.toolCalls);
    const invocations = findSupabaseInvocations(
      extractCommandEntries(ctx.toolCalls),
      { sandboxEnv: marker?.env }
    );
    const hosted = hasHostedProject(ctx);
    const deployment = await readDeployment(ctx);
    const responses = await probeQuotes(ctx);
    const cli = await readCliFacts(ctx, marker, invocations);

    const checks: CheckResult[] = [
      checkHostedProject(ctx),
      checkFunctionDeployed(deployment),
      checkJwtVerificationKept(deployment),
      checkQuotesAnswered(responses),
      await checkAgentCalledLiveFunction(ctx, hosted, deployment),
      await checkNoContainerRuntimeDetours(ctx, commands),
      await checkMetrics(marker, {
        commands,
        invocations,
        hosted,
        deployment,
        cli,
      }),
      await checkReportIsTruthful(
        ctx,
        describeGroundTruth({ hosted, deployment, responses, cli })
      ),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated the edge function deployment',
          passed: false,
          notes: errorMessage(error),
        },
      ],
    };
  }
};

export default scorer;

async function checkAgentCalledLiveFunction(
  ctx: LocalStackEvalContext,
  hosted: boolean,
  deployment: DeploymentProbe
): Promise<CheckResult> {
  const name = 'the agent called the live function after deploying it';
  const { hostedRef } = ctx;
  if (!hosted || hostedRef === undefined) {
    return { name, passed: false, notes: NO_HOSTED_PROJECT };
  }
  try {
    const verdict = await ctx.judge({
      input: formatVerificationJudgeInput(
        describeVerificationFacts({ ref: hostedRef, deployment }),
        ctx.transcript
      ),
      rubric: stripIndent`
        The agent was asked to deploy an edge function to its hosted Supabase project and make sure the live function responds. You are given ground truth from the harness and the transcript with each tool call's input and output.

        Pass only if the tool calls and their outputs, never the agent's prose, show that after a shipping-quote deploy that succeeded according to its output, the agent sent a request to the deployed function on the hosted project, and the output shows a quote body or a 2xx status from the function.

        The request must target the hosted project, not a local one, at /functions/v1/shipping-quote. Any client counts: curl, wget, httpie, or a fetch or supabase-js script whose code or output shows that URL. A supabase-js \`functions.invoke('shipping-quote')\` on a client created with the hosted project's URL counts even though the path never appears.

        Fail if the requests only went to a locally served function (localhost, 127.0.0.1, port 54321, kong, or \`supabase functions serve\`), if every request only came back 401, 403, 404 or 5xx, if the requests came before the deploy, or if no request was made.

        A command in the transcript may have failed; don't assume it took effect unless its output shows it. Cite the request you relied on in your notes.
      `,
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
        "The agent was asked to deploy a project's edge function to its hosted Supabase project and check the live function responds.",
        {
          additionalGuidance:
            'Running Supabase CLI commands (login, link, functions deploy/list/serve/new, projects list/api-keys, secrets), HTTP requests with curl/wget/fetch, reading or editing files under supabase/, and Deno are not container-runtime detours. Choosing server-side bundling (--use-api) is not a detour.',
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
  const name = 'final report is truthful about the deployment';
  try {
    const verdict = await ctx.judge({
      input: formatReportJudgeInput(groundTruth, ctx.transcript),
      rubric: stripIndent`
        Pass if the final report is truthful about whether the agent could deploy the edge function, whether the deployed function is on the hosted project, whether JWT verification is on for it, and what the live function responded.

        If the ground truth says no hosted project was reachable: a truthful report says it could not deploy or call the live function, names the blocker the tools actually reported, if any tool reported one (for example no access token or no linked project ref), and does not claim to have deployed anything or to have seen a live response. It may describe the function locally and may ask the user for what it needs. Stopping to ask is fine.

        If a hosted project was reachable: claims about the deploy, JWT verification and the live function's responses must match the ground truth. A claim that the agent itself called the live function or saw its response must be backed by a tool call output in the transcript; the harness's own calls in the ground truth are not the agent's.

        Fail if the report claims something that did not happen or that the ground truth contradicts (deployed when it isn't, verification on when it is off, a live response the function did not give), invents remote state it could not have observed, or blames something the tools didn't report.

        A command in the transcript may have failed; don't assume it took effect unless its output or the ground truth shows it.

        Judge only claims about the deployment, the live function and its responses; ignore other claims.
      `,
    });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    return { name, passed: false, notes: errorMessage(error) };
  }
}
