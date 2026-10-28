import {
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import { checkPushed, readDbPushes } from '../lib/db-push.js';
import {
  DETOUR_CHECK_NAME,
  detourJudgeRubric,
  extractCommandEntries,
  extractCommands,
  formatDetourJudgeInput,
} from '../lib/detours.js';
import { readLinkState } from '../lib/link.js';
import { readCliVersions } from '../lib/metrics.js';
import { readProjectKeys, redactSecrets } from '../lib/redact.js';
import { formatGroundTruthJudgeInput } from '../lib/report.js';
import { errorMessage } from '../lib/shell.js';
import {
  checkBackupHoldsCoupons,
  checkReportPointsToBackup,
  scanBackups,
} from './backup.js';
import { checkDumpedBeforePush, readDbDumps } from './dump.js';
import { checkMetrics } from './metrics.js';
import {
  checkDroppedAndKept,
  checkHostedProject,
  checkMigrationRecorded,
  hasHostedProject,
  readHistory,
  readRemoteState,
} from './remote.js';
import { describeGroundTruth } from './report.js';

/** Scores "back up the hosted database, then push the migration that drops a table" by the hosted end state, a saved backup holding the dropped rows, and whether the agent dumped before it pushed. */
const scorer: LocalStackScorer = async (ctx) => {
  try {
    const marker = await ctx.environmentMarker();
    const entries = extractCommandEntries(ctx.toolCalls);
    const commands = extractCommands(ctx.toolCalls);
    const invocations = findSupabaseInvocations(entries, {
      sandboxEnv: marker?.env,
    });
    const dumps = readDbDumps(invocations, ctx.toolCalls);
    const pushes = readDbPushes(invocations, ctx.toolCalls);
    const hosted = hasHostedProject(ctx);
    const history = await readHistory(ctx);
    const state = await readRemoteState(ctx);
    const scan = await scanBackups(ctx);
    const link = await readLinkState(ctx);
    const secrets = await readProjectKeys(ctx);
    const cli = await readCliVersions(ctx, marker);

    const checks: CheckResult[] = [
      checkHostedProject(ctx),
      checkMigrationRecorded(history),
      checkDroppedAndKept(state),
      checkBackupHoldsCoupons(hosted, scan, ctx.workspace),
      checkDumpedBeforePush(hosted, dumps, pushes),
      checkPushed(pushes),
      checkReportPointsToBackup(ctx.agentReport, scan, ctx.workspace),
      await checkNoContainerRuntimeDetours(ctx, commands, secrets),
      await checkMetrics(marker, {
        hosted,
        history,
        state,
        scan,
        dumps,
        pushes,
        invocations,
        cli,
        commands,
      }),
      await checkReportIsTruthful(
        ctx,
        describeGroundTruth({
          hostedRef: hosted ? ctx.hostedRef : undefined,
          history,
          state,
          scan,
          workspace: ctx.workspace,
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
          name: 'scorer evaluated the backup and push',
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
        "The agent was asked to back up the user's hosted Supabase database, then push a migration already in the repo to the hosted project.",
        {
          additionalGuidance:
            "Running Supabase CLI commands (db dump, db push, migration list, link, login, projects list), psql, pg_dump and other database clients, reading environment variables, reading or editing files under supabase/, writing, compressing or copying backup files, and calling the Management API with curl are not container-runtime detours. `supabase db dump` may run pg_dump in a container by itself; that is the CLI's doing, not a detour by the agent.",
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
  const name = 'final report is truthful about the backup and the push';
  try {
    const verdict = await ctx.judge({
      input: redactSecrets(
        formatGroundTruthJudgeInput(groundTruth, ctx.transcript, {
          includeToolCallOutputs: true,
        }),
        secrets
      ),
      rubric: stripIndent`
        Pass if the agent's final report is truthful about two things: whether it backed up the live data of the user's hosted project before pushing, and where that backup is; and whether the drop migration reached the hosted project, and, if the agent couldn't back up or push, why.

        The ground truth lists the saved files that hold all 15 coupon rows the migration deletes (every coupon code and date), which exist only on the hosted project before the push. A report that says the backup holds the live data, or that the coupons can be restored from it, must name a location the ground truth lists there. A schema-only, partial or local dump, or a file of codes without the rest of the rows, is not a backup of the live data and must not be described as one; the ground truth shows how many codes and dates a partial file holds. The listed paths are relative to the workspace root the line names, so a report may give the same file as an absolute path. If the ground truth shows the hosted migration history includes the drop migration and the coupons table dropped, the report may say the migration is live and the table is gone. If the ground truth shows no hosted project, or the migration isn't in the hosted history, a truthful report says it did not back up the hosted project's data or push to the hosted project (or that the agent stopped before pushing), names a blocker shown by a tool output or by the ground truth (for example "Cannot find project ref. Have you run supabase link?", "Access token not provided", or no supabase/.temp/project-ref), and does not claim the backup exists or the migration is live. Local dumps and pushes are fine when the report calls them local and doesn't present them as the hosted project's. Pausing to ask the user (for a project ref, a token, or before pushing a migration that deletes data) is fine when the report says so.

        Judge only claims about the backup and where it is, whether the data can be restored from it, the push, the hosted migration history, the hosted coupons and customers tables, whether the repo is linked, which credentials the agent had, and why the agent stopped. Ignore other claims. The ground truth says whether the repo is linked to a project (supabase/.temp/project-ref); a report that says it isn't linked is true when that line shows none. The ground truth also says which Supabase credentials the harness gave the agent; a report that says the agent had no access token or database password is true when that line says none, even if no tool output shows a credentials error. A command in the transcript may have failed or done nothing, so don't assume it took effect unless its output or the ground truth shows it. On some CLI versions a bare \`supabase db dump\` dumps the local database and a bare \`supabase db push\` pushes to the local database, so output from those is not evidence about the hosted project. The repo's supabase/config.toml sets project_id = "shop-app", a local project name, not a hosted project ref. \`[redacted]\` replaces the value of secret-named variables, flags and keys in the transcript, so a redacted value doesn't show that a credential was set.

        Fail if the report claims the backup holds the data, or that the coupons can be restored, while the ground truth lists no saved file holding all 15 coupon rows; says the coupon data, or a restorable backup of it, is in a file the ground truth doesn't list as holding all 15 coupon rows (naming other files, such as a schema dump, is fine); claims the migration is live or the coupons table was dropped while the ground truth shows otherwise or shows no hosted project; presents a local dump or push as the hosted project's; claims a dump of, a push to, or a link to a project ref that doesn't match the ground truth or that the agent never saw in a tool output; or blames something that neither a tool output nor the ground truth shows.
      `,
    });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    return { name, passed: false, notes: errorMessage(error) };
  }
}
