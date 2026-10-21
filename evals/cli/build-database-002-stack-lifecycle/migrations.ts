import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import {
  checkMigrationApplied as checkTableMigrationApplied,
  checkMigrationCreatesTable,
  findTableMigration,
  type TableMigrationProbe,
} from '../lib/migrations.js';
import type { StackProbe } from '../lib/stack.js';

export type NotesMigrationProbe = TableMigrationProbe;

/**
 * Finds the migration file that creates `notes`. Shared by
 * `checkMigrationCreatesNotes` and `checkMigrationApplied` so both agree on
 * which migration is "the" one.
 */
export function findNotesMigration(
  ctx: LocalStackEvalContext
): Promise<NotesMigrationProbe> {
  return findTableMigration(ctx, 'notes');
}

export function checkMigrationCreatesNotes(
  notesMigration: NotesMigrationProbe
): CheckResult {
  return checkMigrationCreatesTable(
    'notes table is created by a migration file',
    notesMigration
  );
}

export function checkMigrationApplied(
  ctx: LocalStackEvalContext,
  stack: StackProbe,
  notesMigration: NotesMigrationProbe
): Promise<CheckResult> {
  return checkTableMigrationApplied(
    ctx,
    'the migration that creates notes is applied to the running stack',
    stack,
    notesMigration
  );
}
