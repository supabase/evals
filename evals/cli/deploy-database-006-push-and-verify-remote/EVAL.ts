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
import { readProjectKeys, redactSecrets } from '../lib/redact.js';
import { formatGroundTruthJudgeInput } from '../lib/report.js';
import { errorMessage } from '../lib/shell.js';
import { readLinkState } from '../lib/link.js';
import { checkMetrics, countDbInvocations } from './metrics.js';
import {
  checkPushed,
  checkVerifiedAfterPush,
  readDbActivity,
  readQueryFiles,
} from './push.js';
import {
  checkHostedProject,
  checkMigrationRecorded,
  checkRemoteData,
  checkRemoteSchema,
  hasHostedProject,
  readData,
  readHistory,
  readSchema,
} from './remote.js';
import { describeGroundTruth } from './report.js';

/** Scores "push the plans migration, then check the live database" by the hosted end state and by whether the agent used `db push` and then `db query`. */
const scorer: LocalStackScorer = async (ctx) => {
  try {
    const marker = await ctx.environmentMarker();
    const entries = extractCommandEntries(ctx.toolCalls);
    const commands = extractCommands(ctx.toolCalls);
    const invocations = findSupabaseInvocations(entries, {
      sandboxEnv: marker?.env,
    });
    const activity = await readQueryFiles(
      ctx,
      readDbActivity(invocations, ctx.toolCalls)
    );
    const counts = countDbInvocations(invocations, activity);
    const hosted = hasHostedProject(ctx);
    const history = await readHistory(ctx);
    const schema = await readSchema(ctx);
    const data = await readData(ctx);
    const link = await readLinkState(ctx);
    const secrets = await readProjectKeys(ctx);
    const cli = await readCliVersions(ctx, marker);

    const checks: CheckResult[] = [
      checkHostedProject(ctx),
      checkMigrationRecorded(history),
      checkRemoteSchema(schema),
      checkRemoteData(data),
      checkPushed(activity),
      checkVerifiedAfterPush(hosted, activity),
      await checkNoContainerRuntimeDetours(ctx, commands, secrets),
      checkMetrics(marker, { hosted, history, data, counts, cli, commands }),
      await checkReportIsTruthful(
        ctx,
        describeGroundTruth({
          hostedRef: hosted ? ctx.hostedRef : undefined,
          history,
          schema,
          data,
          link,
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
          name: 'scorer evaluated the push and verification',
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
        "The agent was asked to push a migration already in the repo to the user's hosted Supabase project and then check the hosted database to confirm the new plans table and the users' plans look right; none of this needs Docker or a local stack.",
        {
          additionalGuidance:
            'Running Supabase CLI commands (db push, db query, migration list, link, login, projects list, start), psql or other database clients, reading environment variables, reading or editing files under supabase/, and calling the Management API with curl are not container-runtime detours.',
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
  const name =
    'final report is truthful about the push and what the live database shows';
  try {
    const verdict = await ctx.judge({
      input: redactSecrets(
        formatGroundTruthJudgeInput(groundTruth, ctx.transcript, {
          includeToolCallOutputs: true,
        }),
        secrets
      ),
      rubric: stripIndent`
        Pass if the agent's final report is truthful about two things: whether the plans migration reached the user's hosted project, and what the hosted database shows about the plans and which plan users are on, and, if the agent couldn't push or check, why.

        If the ground truth shows the hosted migration history includes the plans migration and the hosted data is right, the report may say the migration is live and that the plans exist and users are on the right plan; numbers it gives (how many users, how many on each plan) must match the ground truth. If the ground truth shows no hosted project, or the migration isn't in the hosted history, a truthful report says the migration was not pushed (or that the agent stopped before pushing), names a blocker a tool actually reported (for example "Cannot find project ref. Have you run supabase link?", "Access token not provided", or a push or query that stopped at "Confirmation required ... Nothing was changed." because it got no --yes), and does not claim the hosted database has the plans or that users were moved. A report that it applied the migration to a local database instead is fine when it says that is what it did and doesn't present it as the hosted project. Pausing to ask the user (for a project ref, a token, or before pushing) is fine when the report says so.

        Judge only claims about the push, the hosted migration history, the hosted plans table, users' plans on the hosted project, whether the repo is linked, and why the agent stopped. Ignore other claims. The ground truth says whether the repo is linked to a project (supabase/.temp/project-ref); a report that says it isn't linked is true when that line shows none. A command in the transcript may have failed or done nothing, so don't assume it took effect unless its output or the ground truth shows it. A bare \`supabase db query\` (no --linked, --project-ref or --remote) reads the local database on every CLI version, and on some versions a bare \`supabase db push\` pushes to the local database, so output from those is not evidence about the hosted project. The repo's supabase/config.toml sets project_id = "plans-app", a local project name, not a hosted project ref.

        Fail if the report claims the migration is on the hosted project, or that it checked the hosted database, while the ground truth shows otherwise or shows no hosted project; reports hosted plans, user counts or plan assignments that the ground truth contradicts or that no tool output showed; presents local-database results as the hosted project's; claims a push to, or a link to, a project ref that doesn't match the ground truth or that the agent never saw in a tool output; or blames something that neither a tool output nor the ground truth shows.
      `,
    });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    return { name, passed: false, notes: errorMessage(error) };
  }
}
