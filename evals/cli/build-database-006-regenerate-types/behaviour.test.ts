// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/build-database-006-regenerate-types
import { describe, expect, it } from 'vitest';
import {
  BEHAVIOUR_CHECK_NAME,
  BEHAVIOUR_RUBRIC,
  formatBehaviourJudgeInput,
  readNewMigrationSql,
  readSeededAppFiles,
} from './behaviour.js';
import { readLocal } from './fixtures.js';

const MIGRATION_SQL =
  "create type public.task_status as enum ('todo', 'in_progress', 'done');\nalter table public.tasks drop column is_complete;\n";

describe('BEHAVIOUR_CHECK_NAME', () => {
  it('names the check', () => {
    expect(BEHAVIOUR_CHECK_NAME).toBe(
      'app code keeps its behaviour on the new schema'
    );
  });
});

function labelBefore(text: string, marker: string): string {
  const labels = [
    ...text.slice(0, text.indexOf(marker)).matchAll(/seeded|final/gi),
  ];
  return labels.at(-1)?.[0].toLowerCase() ?? '';
}

describe('formatBehaviourJudgeInput', () => {
  const input = {
    migrationSql: MIGRATION_SQL,
    seededFiles: [
      { path: 'src/tasks.ts', source: 'SOURCE_ALPHA' },
      { path: 'src/supabase.ts', source: 'SOURCE_BRAVO' },
    ],
    finalFiles: [
      { path: 'src/tasks.ts', source: 'SOURCE_CHARLIE' },
      { path: 'src/board.ts', source: 'SOURCE_DELTA' },
    ],
  };

  it('contains the migration SQL, every file path and every source', () => {
    const text = formatBehaviourJudgeInput(input);

    expect(text).toContain(MIGRATION_SQL);
    for (const file of [...input.seededFiles, ...input.finalFiles]) {
      expect(text).toContain(file.path);
      expect(text).toContain(file.source);
    }
  });

  it('labels each source with the nearest preceding seeded or final heading', () => {
    const text = formatBehaviourJudgeInput(input);

    expect(labelBefore(text, 'SOURCE_ALPHA')).toBe('seeded');
    expect(labelBefore(text, 'SOURCE_BRAVO')).toBe('seeded');
    expect(labelBefore(text, 'SOURCE_CHARLIE')).toBe('final');
    expect(labelBefore(text, 'SOURCE_DELTA')).toBe('final');
  });

  it('keeps a source longer than 5000 characters whole', () => {
    const long = `export const table = [\n${'  { id: 1, title: "padding row" },\n'.repeat(400)}];\n// END-OF-LONG-SOURCE\n`;
    expect(long.length).toBeGreaterThan(5000);

    const text = formatBehaviourJudgeInput({
      ...input,
      finalFiles: [{ path: 'src/tasks.ts', source: long }],
    });

    expect(text).toContain(long);
  });

  it('still carries the migration and the seeded files when the agent left no final files', () => {
    const text = formatBehaviourJudgeInput({ ...input, finalFiles: [] });

    expect(text).toContain(MIGRATION_SQL);
    expect(text).toContain('SOURCE_ALPHA');
  });
});

describe('readSeededAppFiles', () => {
  const files = readSeededAppFiles();

  it('returns the seeded app files but not the generated types', () => {
    expect(files.map((file) => file.path).sort()).toEqual([
      'src/supabase.ts',
      'src/tasks.ts',
    ]);
  });

  it('carries the real seeded sources', () => {
    const byPath = new Map(files.map((file) => [file.path, file.source]));

    expect(byPath.get('src/tasks.ts')).toBe(readLocal('src/tasks.ts'));
    expect(byPath.get('src/supabase.ts')).toBe(readLocal('src/supabase.ts'));
    expect(byPath.get('src/tasks.ts')).toContain('is_complete');
  });
});

describe('readNewMigrationSql', () => {
  it('returns the status migration', () => {
    const sql = readNewMigrationSql();

    expect(sql).toBe(
      readLocal('supabase/migrations/20260315000000_task_status.sql')
    );
    expect(sql).toContain('task_status');
    expect(sql).toContain('is_complete');
  });
});

describe('BEHAVIOUR_RUBRIC', () => {
  it('states how the old flag maps onto the new status values', () => {
    expect(BEHAVIOUR_RUBRIC).toContain('is_complete');
    expect(BEHAVIOUR_RUBRIC).toContain('status');
    expect(BEHAVIOUR_RUBRIC).toContain('done');
    expect(BEHAVIOUR_RUBRIC).toContain('todo');
    expect(BEHAVIOUR_RUBRIC).toContain('in_progress');
  });
});
