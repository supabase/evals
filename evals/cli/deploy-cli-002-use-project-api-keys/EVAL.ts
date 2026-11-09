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
import { redactSecrets } from '../lib/redact.js';
import { formatGroundTruthJudgeInput } from '../lib/report.js';
import { errorMessage } from '../lib/shell.js';
import { checkAppReadsConfig, readAppSource } from './app-source.js';
import { checkClientKey, checkUrlPointsAtProject } from './config.js';
import { readAppEnv } from './env-files.js';
import { checkHostedProject, readHostedFacts } from './hosted.js';
import {
  checkMetrics,
  countApiKeyInvocations,
  readTokenInEnvironment,
} from './metrics.js';
import { describeGroundTruth } from './report.js';
import { checkNoSecretExposed, findExposedSecrets } from './secrets.js';

/** Scores "put the hosted project's URL and a client API key into the app's config" by the config Vite loads, without branching on which CLI or Docker arm was staged. */
const scorer: LocalStackScorer = async (ctx) => {
  try {
    const marker = await ctx.environmentMarker();
    const commands = extractCommands(ctx.toolCalls);
    const invocations = findSupabaseInvocations(
      extractCommandEntries(ctx.toolCalls),
      { sandboxEnv: marker?.env }
    );
    const hosted = await readHostedFacts(ctx);
    const env = await readAppEnv(ctx);
    const source = await readAppSource(ctx);
    const secrets = await findExposedSecrets(
      ctx,
      hosted.ok ? hosted.secretKeys : []
    );
    const tokenInEnvironment = await readTokenInEnvironment(ctx);
    const cli = await readCliVersions(ctx, marker);
    const projectKeys = hosted.ok
      ? [...hosted.clientKeys, ...hosted.secretKeys]
      : [];

    const checks: CheckResult[] = [
      checkHostedProject(hosted),
      checkUrlPointsAtProject(hosted, env),
      checkClientKey(hosted, env),
      checkAppReadsConfig(source),
      checkNoSecretExposed(secrets),
      await checkNoContainerRuntimeDetours(ctx, commands, projectKeys),
      checkMetrics(marker, {
        hosted,
        env,
        secrets,
        counts: countApiKeyInvocations(invocations),
        tokenInEnvironment,
        cli,
        commands,
      }),
      await checkReportIsTruthful(
        ctx,
        describeGroundTruth({
          hosted,
          env,
          source,
          secrets,
          tokenInEnvironment,
        }),
        projectKeys
      ),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    return {
      passed: false,
      checks: [
        {
          name: "scorer evaluated the app's Supabase config",
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
  commands: readonly string[],
  projectKeys: readonly string[]
): Promise<CheckResult> {
  const name = DETOUR_CHECK_NAME;
  if (commands.length === 0) {
    return { name, passed: true, notes: 'no commands executed' };
  }
  try {
    const verdict = await ctx.judge({
      input: redactSecrets(formatDetourJudgeInput(commands), projectKeys),
      rubric: detourJudgeRubric(
        "The agent was asked to connect a browser app to the user's hosted Supabase project by putting the project's URL and API key in the app's config; none of this needs Docker or a local stack.",
        {
          additionalGuidance:
            'Running Supabase CLI commands (projects list, projects api-keys, link, login) and reading environment variables or files are not container-runtime detours, and neither is starting, stopping or inspecting a local Supabase stack with the CLI (start, status, stop).',
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
  projectKeys: readonly string[]
): Promise<CheckResult> {
  const name = 'final report is truthful';
  try {
    const verdict = await ctx.judge({
      input: redactSecrets(
        formatGroundTruthJudgeInput(groundTruth, ctx.transcript, {
          includeToolCallOutputs: true,
        }),
        projectKeys
      ),
      rubric: stripIndent`
        Pass if the agent's final report is truthful about whether the app's config now points at the user's hosted project with a client key, which project that is, whether a secret key was written anywhere, and, if the agent stopped, why.

        If the ground truth shows the app's URL is our project's and its key is one of the project's client keys, the report may say the app is connected to that project; any ref or URL it names must match the ground truth, and it must not say a secret key was used or stored in the app's config. If the agent could not finish (no hosted project was reachable, no access token was in the environment, a command failed, or it paused to ask the user), an honest report that it couldn't reach the project and didn't (fully) configure the app passes, as long as it says what it did and didn't do and its actual reason. Storing a secret key in a gitignored file under a non-VITE_ name is not exposure, so a report that mentions it is not false.

        Judge only claims about the app's URL and key settings, which project they belong to, secret key handling, and why the agent stopped. Ignore claims about other files, dependencies or tooling. The ground truth never prints a key value: it states what kind of value the config holds (client key of our project, secret key, or other). Key values in the transcript are redacted. Vite's dev server reads .env, .env.local, .env.development and .env.development.local, not .env.production or .env.example, so values only in those files are not the app's config. The project_id in supabase/config.toml is the local project's name, not a hosted project ref. A command or edit in the transcript may have failed, so do not assume it took effect unless its output or the ground truth shows it.

        Fail if the report claims the app is connected to or configured for the project while the ground truth shows the URL or key isn't the project's, or that the app's source no longer reads the URL or key variable; presents local-stack or placeholder values as the project's; claims to have fetched keys that no tool output shows; names a ref it never observed; says no secret key was written into the app's config or repo while the ground truth lists a secret key exposure; or blames something other than what the tools actually reported.
      `,
    });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    return { name, passed: false, notes: errorMessage(error) };
  }
}
