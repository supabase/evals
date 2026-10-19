import type { CheckResult } from '@supabase-evals/core';
import { describeStack, type StackProbe } from '../lib/stack.js';
import type { CliFacts, ProjectFileFacts } from './metrics.js';
import type { ColumnMigrationsProbe } from './migrations.js';
import type { ColumnProbe } from './schema.js';

function describeProbeCli({ versions, cliOverride }: CliFacts): string[] {
  const installed = versions?.cliVersion ?? 'unknown';
  const afterRun =
    versions?.cliVersionAfterRun === undefined
      ? ''
      : `; PATH supabase reported ${versions.cliVersionAfterRun} after the run`;
  return [
    `- installed CLI: ${installed}${afterRun}; every stack probe below ran with the installed CLI, so stacks the agent created through a different Supabase CLI build may not appear here`,
    ...(cliOverride !== null && cliOverride.length > 0
      ? [`- agent ran ${cliOverride.join(', ')}; scorer uses the installed CLI`]
      : []),
  ];
}

function describeColumn(column: ColumnProbe): string {
  if (!column.ok) return `unavailable (${column.notes})`;
  if (!column.exists) return 'missing';
  return `${column.dataType}, ${column.nullable ? 'nullable' : 'not null'}`;
}

function describeMigrations(migrations: ColumnMigrationsProbe): string {
  return migrations.ok
    ? migrations.migrations
        .map(({ file, version }) => `${file} (version ${version})`)
        .join(', ')
    : `none (${migrations.notes})`;
}

function describeSeededMigration({
  seededMigrationModified,
}: ProjectFileFacts): string {
  if (seededMigrationModified === null) return 'unknown';
  return seededMigrationModified ? 'yes' : 'no';
}

/** Harness-observed facts about the schema change, for the truthful-report judge. */
export function describeGroundTruth(facts: {
  workspace: string;
  stack: StackProbe;
  column: ColumnProbe;
  migrations: ColumnMigrationsProbe;
  recorded: CheckResult;
  files: ProjectFileFacts;
  cli: CliFacts;
}): string[] {
  const { recorded } = facts;
  return [
    `- project directory: ${facts.workspace}`,
    ...describeProbeCli(facts.cli),
    `- local stack: ${describeStack(facts.stack)}`,
    `- tasks.due_date in the local database: ${describeColumn(facts.column)}`,
    `- new migration adding due_date: ${describeMigrations(facts.migrations)}`,
    `- recorded in the local migration history: ${recorded.passed ? 'yes' : 'no'}${recorded.notes ? ` (${recorded.notes})` : ''}`,
    `- seeded migration modified: ${describeSeededMigration(facts.files)}`,
  ];
}
