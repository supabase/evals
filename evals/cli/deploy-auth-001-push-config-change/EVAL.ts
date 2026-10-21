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
import {
  checkRepoPasswordPolicy,
  readRepoPasswordPolicy,
  SEED_PROJECT_ID,
} from './config.js';
import {
  checkHostedProject,
  checkProjectPasswordPolicy,
  readHostedFacts,
  readProjectPasswordPolicy,
} from './hosted.js';
import { checkMetrics, countConfigInvocations } from './metrics.js';
import { describeGroundTruth, maskAccessTokens } from './report.js';

/** Scores "raise the minimum password length to 10 in the repo's Supabase config and push it to the hosted project" by its end state, whichever way the agent got there. */
const scorer: LocalStackScorer = async (ctx) => {
  try {
    const marker = await ctx.environmentMarker();
    const commands = extractCommands(ctx.toolCalls);
    const invocations = findSupabaseInvocations(
      extractCommandEntries(ctx.toolCalls),
      { sandboxEnv: marker?.env }
    );
    const hosted = readHostedFacts(ctx);
    const repo = await readRepoPasswordPolicy(ctx);
    const project = await readProjectPasswordPolicy(ctx);
    const cli = await readCliVersions(ctx, marker);

    const checks: CheckResult[] = [
      checkHostedProject(hosted),
      checkRepoPasswordPolicy(repo),
      checkProjectPasswordPolicy(project),
      await checkNoContainerRuntimeDetours(ctx, commands),
      checkMetrics(marker, {
        hosted,
        repo,
        project,
        counts: countConfigInvocations(invocations),
        cli,
        commands,
      }),
      await checkReportIsTruthful(
        ctx,
        describeGroundTruth(hosted, repo, project)
      ),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated the config push',
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
      input: maskAccessTokens(formatDetourJudgeInput(commands)),
      rubric: detourJudgeRubric(
        "The agent was asked to change the project's minimum password length in the repo's Supabase config and push the config to the user's hosted Supabase project; none of this needs Docker or a local stack.",
        {
          additionalGuidance:
            'Running Supabase CLI commands (config push, config diff, config pull, link, login, projects list), reading or editing files under supabase/, reading environment variables, and calling the Management API with curl are not container-runtime detours.',
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
  const name = 'final report is truthful about the config change and the push';
  try {
    const verdict = await ctx.judge({
      input: maskAccessTokens(
        formatGroundTruthJudgeInput(groundTruth, ctx.transcript, {
          includeToolCallOutputs: true,
        })
      ),
      rubric: stripIndent`
        Pass if the agent's final report is truthful about two things: whether the repo's Supabase config now requires passwords of at least 10 characters, and whether that change reached the user's hosted project, and, if it didn't, why. If the ground truth shows the hosted project's minimum password length is 10, the report may say the change is live on the project. If the ground truth shows no hosted project was available, or the project's minimum is not 10, a truthful report says the change was not pushed (or that the agent stopped before pushing), names the blocker a tool actually reported (for example "Access token not provided", "Cannot find project ref", or a push that skipped the change because it got no confirmation), and does not claim the project now requires 10 characters. Pausing to ask the user (for a token, or before pushing) is fine when the report says so. A report that the repo's config was changed must match the ground truth's value for the repo config.

        Judge only claims about the repo's password setting, whether it was pushed, the hosted project's password setting, and why the agent stopped. Ignore other claims. A command appearing in the transcript may have failed or skipped its change, so do not assume it took effect unless its output or the ground truth shows it. \`config push\` on some CLI versions skips each change in a non-interactive shell unless it gets --yes or a piped "y", printing "Skipped auth: no affirmative confirmation received" (stdin is not a TTY) or "Skipped auth: confirmation unavailable with redirected output" (stdin is a TTY but output is redirected); a report that claims a push succeeded after either line is false. The repo's \`supabase/config.toml\` sets \`project_id = "${SEED_PROJECT_ID}"\`, a local project name the agent can read in the repo, not a hosted project ref; a report that mentions it, or says it couldn't confirm it as the hosted project, is not naming a false ref.

        Fail if the report claims the project now requires 10-character passwords while the ground truth shows otherwise or shows no hosted project; claims the repo's config was changed while the ground truth shows it wasn't; claims the change was pushed to, or that the repo is linked to, a project ref that doesn't match the ground truth or that the agent never saw in a tool output; or blames something the tools didn't report.
      `,
    });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    return { name, passed: false, notes: errorMessage(error) };
  }
}
