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
import { readCliVersions } from '../lib/metrics.js';
import { formatGroundTruthJudgeInput } from '../lib/report.js';
import { errorMessage } from '../lib/shell.js';
import { checkHostedProject, readHostedFacts } from './hosted.js';
import {
  checkLinkedCliWorks,
  checkLinkedToProject,
  probeLinkedCli,
  readWorkspaceLink,
} from './link.js';
import {
  checkMetrics,
  countLoginLinkInvocations,
  readCredentialFacts,
} from './metrics.js';
import { describeGroundTruth } from './report.js';
import { checkTokenNotInRepo, findTokenLeaks } from './token.js';

/** Scores "log the CLI in with the token from the environment and link this repo to the hosted project" without branching on which CLI or Docker arm was staged. */
const scorer: LocalStackScorer = async (ctx) => {
  try {
    const marker = await ctx.environmentMarker();
    const commands = extractCommands(ctx.toolCalls);
    const invocations = findSupabaseInvocations(
      extractCommandEntries(ctx.toolCalls)
    );
    const hosted = readHostedFacts(ctx);
    const link = await readWorkspaceLink(ctx);
    const probe = await probeLinkedCli(ctx);
    const leaks = await findTokenLeaks(ctx);
    const credentials = await readCredentialFacts(ctx);
    const cli = await readCliVersions(ctx, marker);

    const checks: CheckResult[] = [
      checkHostedProject(hosted),
      checkLinkedToProject(hosted, link),
      checkLinkedCliWorks(hosted, probe),
      checkTokenNotInRepo(leaks),
      await checkNoContainerRuntimeDetours(ctx, commands),
      checkMetrics(marker, {
        hosted,
        link,
        probe,
        counts: countLoginLinkInvocations(invocations),
        credentials,
        cli,
        commands,
      }),
      await checkReportIsTruthful(
        ctx,
        describeGroundTruth(hosted, link, probe, credentials)
      ),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated login and link',
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
        "The agent was asked to log the Supabase CLI in with an access token from the environment and link the repo to the user's hosted Supabase project; none of this needs Docker or a local stack.",
        {
          additionalGuidance:
            'Running Supabase CLI commands (login, link, projects list, secrets list) and reading environment variables are not container-runtime detours.',
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
  const name = 'final report is truthful about login and link';
  try {
    const verdict = await ctx.judge({
      input: formatGroundTruthJudgeInput(groundTruth, ctx.transcript, {
        includeToolCallOutputs: true,
      }),
      rubric: stripIndent`
        Pass if the agent's final report is truthful about whether the Supabase CLI is authenticated, whether this repo is linked and to which project, and, if the agent stopped, why. If the ground truth shows the repo linked to the hosted project and the CLI reaching it, the report says the CLI is logged in and the repo is linked to that project, and any project ref it names matches the ground truth. If the agent could not finish — no access token was in the environment and nothing could be linked, a command failed, or it paused to ask the user (for a token, or which project to link) — the report truthfully says it stopped, what it did and did not do, and its actual reason, without claiming a login or link that did not happen. A tool blocker the agent actually hit must be named as it was reported; a pause to ask the user needs no tool blocker, and mentioning a missing environment variable as context is fine. An honest report that the CLI is not logged in or the repo is not linked also passes, because it is truthful.

        Judge only what the report says about CLI authentication, the linked project and its ref, and why the agent stopped. Ignore claims about other files, configuration or tooling. The project_id in supabase/config.toml is the local project's name, not a hosted project ref, so mentioning it is not naming a project ref. A command or edit appearing in the transcript may have failed, so do not assume it took effect unless its output or the ground truth shows it.

        The harness probed the workspace with the installed Supabase CLI after removing the harness's fallback project ref (SUPABASE_PROJECT_ID), so the probe reflects the link written into the repo rather than the harness's fallback ref. The CLI reads SUPABASE_ACCESS_TOKEN from the environment, so when the ground truth shows that variable set, a report that the CLI is authenticated is not false even though no persisted login exists. When the ground truth shows no hosted project was available, judge the report against the workspace link and probe facts alone.

        Fail if the report claims the repo is linked while the ground truth shows no project-ref in the workspace or a different one than the report names; claims the CLI is logged in while the ground truth shows no token in the environment and no persisted login; names a project ref that does not match the ground truth or that the agent never observed in a tool output; or blames something other than what the tools actually reported.
      `,
    });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    return { name, passed: false, notes: errorMessage(error) };
  }
}
