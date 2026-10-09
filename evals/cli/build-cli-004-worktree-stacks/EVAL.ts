import {
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import {
  DETOUR_CHECK_NAME,
  detourJudgeRubric,
  extractCommandEntries,
  extractCommands,
  formatDetourJudgeInput,
} from '../lib/detours.js';
import { checkMetrics } from './metrics.js';
import {
  checkWorktreeMigrationApplied,
  checkWorktreeMigrationCreates,
  findWorktreeMigrations,
} from './migrations.js';
import { checkReportedPorts } from './report.js';
import { checkDistinctStacks, resolveWorktreeStacks } from './stacks.js';
import { checkSchemaIsolation, checkSeeded } from './tables.js';
import { WORKTREE_TABLES, checkWorktrees } from './worktrees.js';

/** Scores "one isolated local stack per git worktree" without branching on which CLI backend, runtime or Docker arm was staged. */
const scorer: LocalStackScorer = async (ctx) => {
  try {
    const marker = await ctx.environmentMarker();
    const commands = extractCommands(ctx.toolCalls);
    const invocations = findSupabaseInvocations(
      extractCommandEntries(ctx.toolCalls)
    );
    const worktrees = await checkWorktrees(ctx);
    const stacks = await resolveWorktreeStacks(
      ctx,
      worktrees.dirs,
      invocations
    );
    const migrations = await findWorktreeMigrations(ctx, worktrees.dirs);

    const checks: CheckResult[] = [
      worktrees.check,
      checkDistinctStacks(stacks),
      ...(await Promise.all(
        WORKTREE_TABLES.map((entry) => checkSchemaIsolation(ctx, stacks, entry))
      )),
      ...(await Promise.all(
        WORKTREE_TABLES.map((entry) => checkSeeded(ctx, stacks, entry))
      )),
      ...WORKTREE_TABLES.map((entry) =>
        checkWorktreeMigrationCreates(migrations, entry)
      ),
      ...(await Promise.all(
        WORKTREE_TABLES.map((entry) =>
          checkWorktreeMigrationApplied(ctx, stacks, migrations, entry)
        )
      )),
      checkReportedPorts(stacks, ctx.agentReport ?? ''),
      await checkNoContainerRuntimeDetours(ctx, commands),
      await checkMetrics(ctx, marker, invocations, stacks),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        { name: 'scorer evaluated worktree stacks', passed: false, notes: msg },
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
        'The agent was asked to set up a git repo with three worktrees and run a local Supabase stack in each, with its own table and a sample row.',
        {
          additionalGuidance:
            'Creating git repos, branches and worktrees, editing files, and using psql or other client tools against the stacks are not container-runtime detours.',
        }
      ),
    });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}
