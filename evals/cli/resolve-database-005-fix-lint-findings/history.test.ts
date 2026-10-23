// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-005-fix-lint-findings
import { describe, expect, it } from 'vitest';
import { checkHistoryRecordsFiles, HISTORY_CHECK } from './history.js';
import type { ReplayFile } from './probe.js';

const SEEDED_FILES: ReplayFile[] = [
  { name: '20260101000000_create_orders.sql', sql: '' },
  { name: '20260201000000_order_items_policies.sql', sql: '' },
  { name: '20260301000000_unit_price_and_updated_at.sql', sql: '' },
];
const FIX: ReplayFile = {
  name: '20261022000000_fix_lint_findings.sql',
  sql: '',
};

const SEEDED_VERSIONS = ['20260101000000', '20260201000000', '20260301000000'];

describe('checkHistoryRecordsFiles', () => {
  it('keeps the check name stable for the results dashboard', () => {
    expect(HISTORY_CHECK).toBe(
      'every migration file is recorded in the local migration history'
    );
  });

  it('passes when every file version is in the history', () => {
    expect(
      checkHistoryRecordsFiles(SEEDED_FILES, { versions: SEEDED_VERSIONS })
    ).toEqual({
      name: HISTORY_CHECK,
      passed: true,
      notes: '3 files recorded',
    });
  });

  it('passes when a new migration was applied through the CLI as well', () => {
    const result = checkHistoryRecordsFiles([...SEEDED_FILES, FIX], {
      versions: [...SEEDED_VERSIONS, '20261022000000'],
    });
    expect(result.passed).toBe(true);
    expect(result.notes).toBe('4 files recorded');
  });

  it('passes when the history holds versions with no file on disk', () => {
    expect(
      checkHistoryRecordsFiles(SEEDED_FILES, {
        versions: [...SEEDED_VERSIONS, '20250101000000'],
      }).passed
    ).toBe(true);
  });

  it('fails, naming the file, when a new migration was written but never applied through the CLI', () => {
    const result = checkHistoryRecordsFiles([...SEEDED_FILES, FIX], {
      versions: SEEDED_VERSIONS,
    });
    expect(result).toMatchObject({ name: HISTORY_CHECK, passed: false });
    expect(result.notes).toContain(FIX.name);
    expect(result.notes).not.toContain(SEEDED_FILES[0].name);
  });

  it('names every unrecorded file', () => {
    const result = checkHistoryRecordsFiles([...SEEDED_FILES, FIX], {
      versions: ['20260101000000'],
    });
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(SEEDED_FILES[1].name);
    expect(result.notes).toContain(SEEDED_FILES[2].name);
    expect(result.notes).toContain(FIX.name);
    expect(result.notes).not.toContain(SEEDED_FILES[0].name);
  });

  it('matches the whole version, not a prefix of a longer one', () => {
    const result = checkHistoryRecordsFiles([FIX], {
      versions: ['202610220000001'],
    });
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(FIX.name);
  });

  it('fails when the history holds no versions', () => {
    expect(
      checkHistoryRecordsFiles(SEEDED_FILES, { versions: [] }).passed
    ).toBe(false);
  });

  it('fails with the error when the history could not be read', () => {
    const result = checkHistoryRecordsFiles(SEEDED_FILES, {
      error: 'relation "supabase_migrations.schema_migrations" does not exist',
    });
    expect(result).toMatchObject({ name: HISTORY_CHECK, passed: false });
    expect(result.notes).toContain(
      'relation "supabase_migrations.schema_migrations" does not exist'
    );
  });

  it('fails when the probe returned no history row', () => {
    const result = checkHistoryRecordsFiles(SEEDED_FILES, undefined);
    expect(result).toMatchObject({ name: HISTORY_CHECK, passed: false });
    expect(result.notes).toBeTruthy();
  });
});
