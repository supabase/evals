import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import {
  checkMigrationApplied,
  checkMigrationCreatesTable,
  findTableMigration,
  type TableMigrationProbe,
} from '../lib/migrations.js';
import type { WorktreeStacks } from './stacks.js';
import {
  WORKTREE_TABLES,
  type Worktree,
  type WorktreeDirs,
  type WorktreeTable,
} from './worktrees.js';

export type WorktreeMigrations = Record<Worktree, TableMigrationProbe>;

/** The migration file in each worktree that creates its table. */
export async function findWorktreeMigrations(
  ctx: Pick<LocalStackEvalContext, 'exec' | 'folderExists'>,
  dirs: WorktreeDirs
): Promise<WorktreeMigrations> {
  const migrations = {} as WorktreeMigrations;
  for (const { worktree, table } of WORKTREE_TABLES) {
    const dir = dirs[worktree];
    migrations[worktree] =
      dir === undefined
        ? { ok: false, notes: 'worktree directory not found' }
        : await findTableMigration(ctx, table, dir);
  }
  return migrations;
}

export function checkWorktreeMigrationCreates(
  migrations: WorktreeMigrations,
  { worktree, table }: WorktreeTable
): CheckResult {
  return checkMigrationCreatesTable(
    `${table} is created by a migration file in ${worktree}`,
    migrations[worktree]
  );
}

/** The creating migration's version is in the worktree's own stack's applied history. */
export function checkWorktreeMigrationApplied(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  stacks: WorktreeStacks,
  migrations: WorktreeMigrations,
  { worktree, table }: WorktreeTable
): Promise<CheckResult> {
  return checkMigrationApplied(
    ctx,
    `the migration that creates ${table} is applied to ${worktree}'s stack`,
    stacks[worktree],
    migrations[worktree]
  );
}
