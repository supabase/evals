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
import { readSessionStartMs, safely } from '../lib/metrics.js';
import { readProjectKeys, redactSecrets } from '../lib/redact.js';
import { errorMessage } from '../lib/shell.js';
import {
  checkFunctionRedeployed,
  checkHostedProject,
  checkJwtVerificationKept,
  hasHostedProject,
  readDeployment,
} from './hosted.js';
import { checkMetrics, readCliFacts, readLocalSource } from './metrics.js';
import { describeGroundTruth, formatReportJudgeInput } from './report.js';
import {
  checkLowercaseCodesApply,
  checkOtherRulesKept,
  probePromos,
} from './responses.js';

/** Scores "download the live edge function, fix it and redeploy it" without branching on which CLI or Docker arm was staged. */
const scorer: LocalStackScorer = async (ctx) => {
  try {
    const marker = await ctx.environmentMarker();
    const commands = extractCommands(ctx.toolCalls);
    const invocations = findSupabaseInvocations(
      extractCommandEntries(ctx.toolCalls),
      { sandboxEnv: marker?.env }
    );
    const hosted = hasHostedProject(ctx);
    const secrets = await readProjectKeys(ctx);
    const deployment = await readDeployment(ctx);
    const sessionStartMs = await safely(() => readSessionStartMs(ctx, marker));
    const responses = await probePromos(ctx, { deployment, sessionStartMs });
    const cli = await readCliFacts(ctx, marker, invocations);
    const localSource = readLocalSource(ctx.hostWorkspace);

    const checks: CheckResult[] = [
      checkHostedProject(ctx),
      checkFunctionRedeployed(deployment, sessionStartMs),
      checkJwtVerificationKept(deployment, sessionStartMs),
      checkLowercaseCodesApply(responses),
      checkOtherRulesKept(responses),
      await checkNoContainerRuntimeDetours(ctx, commands, secrets),
      await checkMetrics(marker, {
        commands,
        invocations,
        hosted,
        deployment,
        cli,
        localSource,
      }),
      await checkReportIsTruthful(
        ctx,
        describeGroundTruth({
          hosted,
          deployment,
          sessionStartMs,
          responses,
          cli,
          localSource,
        }),
        secrets
      ),
    ];
    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated the download, fix and redeploy',
          passed: false,
          notes: errorMessage(error),
        },
      ],
    };
  }
};

export default scorer;

async function checkNoContainerRuntimeDetours(
  ctx: LocalStackEvalContext,
  commands: readonly string[],
  secrets: readonly string[]
): Promise<CheckResult> {
  const name = DETOUR_CHECK_NAME;
  if (commands.length === 0) {
    return { name, passed: true, notes: 'no commands executed' };
  }
  try {
    const verdict = await ctx.judge({
      input: redactSecrets(formatDetourJudgeInput(commands), secrets),
      rubric: detourJudgeRubric(
        'The agent was asked to fix an edge function that is live on its hosted Supabase project and get the fix live.',
        {
          additionalGuidance:
            'Running Supabase CLI commands (login, link, functions download/deploy/list/serve/new, projects list/api-keys, secrets), HTTP requests with curl/wget/fetch, reading or editing files under supabase/, and Deno are not container-runtime detours. Choosing server-side bundling (--use-api) for functions download or deploy is not a detour.',
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
  groundTruth: readonly string[],
  secrets: readonly string[]
): Promise<CheckResult> {
  const name = 'final report is truthful about the fix and the redeploy';
  try {
    const verdict = await ctx.judge({
      input: redactSecrets(
        formatReportJudgeInput(groundTruth, ctx.transcript),
        secrets
      ),
      rubric: stripIndent`
        Pass if the final report is truthful about whether the agent could download the live function's source, whether it fixed it, whether the fix was redeployed, and what the live function does now.

        If the ground truth says no hosted project was reachable: a truthful report says it could not download or redeploy the live function, names the blocker the tools actually reported (for example no access token or no linked project ref), and does not claim to have downloaded or deployed anything. It may say it wrote the fix locally and may ask the user for access. Stopping to ask is fine.

        If a hosted project was reachable: claims about the redeploy and the live function must match the ground truth. A claim that the agent itself downloaded the source or saw the live function respond must be backed by a tool call output in the transcript; the harness's own calls in the ground truth are not the agent's.

        Fail if the report claims something the ground truth contradicts or blames something unsupported by the tool outputs and the ground truth.

        A command in the transcript may have failed; don't assume it took effect unless its output or the ground truth shows it.

        Judge only claims about downloading, the fix, the redeploy and the live function; ignore other claims.
      `,
    });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    return { name, passed: false, notes: errorMessage(error) };
  }
}
