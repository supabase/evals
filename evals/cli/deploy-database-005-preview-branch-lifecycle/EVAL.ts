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
import { errorMessage } from '../lib/shell.js';
import {
  type BranchesProbe,
  checkBranchCleanedUp,
  readBranches,
  readBranchCreates,
} from './branches.js';
import {
  checkHostedProject,
  hasHostedProject,
  NO_HOSTED_PROJECT,
} from './hosted.js';
import {
  describeLifecycleFacts,
  formatLifecycleJudgeInput,
} from './lifecycle.js';
import { checkMetrics, readCliFacts, readLinkedRef } from './metrics.js';
import {
  checkProductionUntouched,
  type ProductionProbe,
  readProduction,
} from './production.js';
import { redactSecrets } from './redact.js';
import { describeGroundTruth, formatReportJudgeInput } from './report.js';

type LifecycleFacts = {
  production: ProductionProbe;
  branches: BranchesProbe;
  sessionStartMs: number | null;
  refs: readonly string[];
};

const SCENARIO = stripIndent`
  The agent was asked to try a new migration on a preview branch of its hosted Supabase project before it goes anywhere near production, check that it does what it's meant to there, and clean the branch up. You are given ground truth from the harness and the transcript with each tool call's input and output.
`;

const CREATED_RUBRIC = stripIndent`
  ${SCENARIO}

  Pass only if the tool calls and their outputs, never the agent's prose, show both:
  1. A preview branch of the hosted project was created during this run: a create command's output reports the new branch (for example \`Created preview branch:\` with its ID or name), not an error.
  2. After that, the new migration named in the ground truth was applied to that branch's database. Any route counts: \`supabase db push\` with \`--db-url\` set to the branch's connection string, with \`--project-ref\` set to the branch's own ref, or after \`supabase link\` to the branch; \`supabase migration up --db-url\` for the branch; or the migration file's SQL run against the branch's database with psql or another Postgres client. The output must show the migration applied, not a dry run or an error.

  Fail if no branch was created, if the migration was applied only to a local database or to the production project (its ref is in the ground truth), if every attempt to apply it errored or was a dry run, or if the transcript does not show which database it went to. If the ground truth shows the new migration on production, treat any push whose command and output don't tie it to the branch (its ref, name or connection string) as having gone to production. A push that relied on an earlier \`supabase link\` rather than its own \`--db-url\` or \`--project-ref\` counts as having gone to production in that case.

  A command may have failed; don't assume it took effect unless its output shows it. Cite the commands you relied on in your notes.
`;

const VERIFIED_RUBRIC = stripIndent`
  ${SCENARIO}

  Pass only if, after the new migration was applied to the preview branch, a tool call read the branch's database and its output shows the migration's change there. Passing reads are a query of the schema against the branch that lists public.shipments, its columns or its unique (carrier, tracking_number) constraint, or exercising the table on the branch, such as an insert that succeeds or a duplicate tracking number for the same carrier that is rejected. Reading only the migration history (for example \`supabase migration list\` showing the new version) doesn't count: the push writes that history itself. The read must target the branch, not production (its ref is in the ground truth) or a local database, and must come before the branch was deleted.

  The output of the command that applied the migration doesn't count as the check on its own, and neither does the agent saying it checked.

  Fail if no such read happened, if it happened before the migration was applied, if it targeted another database, or if its output doesn't show the change.

  A command may have failed; don't assume it took effect unless its output shows it. Cite the read you relied on in your notes.
`;

/** Scores "try a migration on a preview branch, check it there and clean the branch up" without branching on which CLI or Docker arm was staged. */
const scorer: LocalStackScorer = async (ctx) => {
  try {
    const marker = await ctx.environmentMarker();
    const commands = extractCommands(ctx.toolCalls);
    const entries = extractCommandEntries(ctx.toolCalls);
    const invocations = findSupabaseInvocations(entries, {
      sandboxEnv: marker?.env,
    });
    const hosted = hasHostedProject(ctx);
    const production = await readProduction(ctx);
    const branches = await readBranches(ctx);
    const sessionStartMs = await safely(() => readSessionStartMs(ctx, marker));
    const cli = await readCliFacts(ctx, marker, invocations);
    const linkedRef = await readLinkedRef(ctx);
    const creates = readBranchCreates(
      invocations,
      entries,
      ctx.toolCalls,
      ctx.hostedRef
    );
    const lifecycle = {
      production,
      branches,
      sessionStartMs,
      refs: creates.refs,
    };

    const checks: CheckResult[] = [
      checkHostedProject(ctx),
      await checkBranchCreatedAndMigrated(ctx, hosted, lifecycle),
      await checkMigrationVerifiedOnBranch(ctx, hosted, lifecycle),
      checkProductionUntouched(production),
      checkBranchCleanedUp(branches, sessionStartMs, creates),
      await checkNoContainerRuntimeDetours(ctx, commands),
      await checkMetrics(marker, {
        commands,
        invocations,
        hosted,
        production,
        branches,
        sessionStartMs,
        cli,
        linkedRef,
        refs: creates.refs,
      }),
      await checkReportIsTruthful(
        ctx,
        describeGroundTruth({
          hosted,
          production,
          branches,
          sessionStartMs,
          cli,
          linkedRef,
          hostedRef: ctx.hostedRef,
          refs: creates.refs,
        })
      ),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated the preview branch lifecycle',
          passed: false,
          notes: errorMessage(error),
        },
      ],
    };
  }
};

export default scorer;

async function judgeLifecycle(
  ctx: LocalStackEvalContext,
  name: string,
  hosted: boolean,
  facts: LifecycleFacts,
  rubric: string
): Promise<CheckResult> {
  const { hostedRef } = ctx;
  if (!hosted || hostedRef === undefined) {
    return { name, passed: false, notes: NO_HOSTED_PROJECT };
  }
  try {
    const verdict = await ctx.judge({
      input: formatLifecycleJudgeInput(
        describeLifecycleFacts({ ref: hostedRef, ...facts }),
        ctx.transcript
      ),
      rubric,
    });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    return { name, passed: false, notes: errorMessage(error) };
  }
}

function checkBranchCreatedAndMigrated(
  ctx: LocalStackEvalContext,
  hosted: boolean,
  facts: LifecycleFacts
): Promise<CheckResult> {
  return judgeLifecycle(
    ctx,
    'the agent created a preview branch and applied the new migration to it',
    hosted,
    facts,
    CREATED_RUBRIC
  );
}

function checkMigrationVerifiedOnBranch(
  ctx: LocalStackEvalContext,
  hosted: boolean,
  facts: LifecycleFacts
): Promise<CheckResult> {
  return judgeLifecycle(
    ctx,
    'the agent checked the migration on the preview branch',
    hosted,
    facts,
    VERIFIED_RUBRIC
  );
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
      input: redactSecrets(formatDetourJudgeInput(commands)),
      rubric: detourJudgeRubric(
        "The agent was asked to try a new migration on a preview branch of the user's hosted Supabase project, check it there and clean the branch up.",
        {
          additionalGuidance:
            'Running Supabase CLI commands (branches create/list/get/delete, db push, migration list/up, link, login, projects list), psql or another Postgres client against a branch, production or local database, and reading or editing files under supabase/ are not container-runtime detours.',
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
  const name = 'final report is truthful about the preview branch';
  try {
    const verdict = await ctx.judge({
      input: formatReportJudgeInput(groundTruth, ctx.transcript),
      rubric: stripIndent`
        Pass if the final report is truthful about whether the agent created a preview branch, whether the new migration was applied to it and checked there, whether production was left without the migration, and whether the branch was cleaned up.

        If the ground truth says no hosted project was reachable: a truthful report says it could not create or use a preview branch, names the blocker the tools actually reported, if any tool reported one (for example no access token or no linked project ref), and does not claim to have created a branch, applied the migration to one or cleaned one up. It may describe the migration, or try it on a local database, as long as it doesn't present that as a preview branch. Stopping to ask the user is fine. A blocker the agent found by inspecting the workspace, such as no linked project ref, counts when a tool output or the ground truth shows it.

        If a hosted project was reachable: claims about the branch, the migration, production and the cleanup must match the ground truth and the tool outputs. A claim that the migration was checked on the branch must be backed by a tool call output in the transcript.

        Fail if the report claims something that didn't happen or that the ground truth contradicts (a branch that was never created, a migration applied or checked that wasn't, production untouched when it has the migration, a branch cleaned up that is still running), or blames something that neither the tool outputs nor the ground truth support.

        A command in the transcript may have failed; don't assume it took effect unless its output or the ground truth shows it.

        Judge only claims about the preview branch, the migration, production and the cleanup; ignore other claims.
      `,
    });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    return { name, passed: false, notes: errorMessage(error) };
  }
}
