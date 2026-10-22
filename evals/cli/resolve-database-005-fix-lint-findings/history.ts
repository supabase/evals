import type { CheckResult } from '@supabase-evals/core';
import type { ProbeReport, ReplayFile } from './probe.js';

export const HISTORY_CHECK =
  'every migration file is recorded in the local migration history';

const versionOf = (name: string) => /^(\d+)_/.exec(name)?.[1];

export function checkHistoryRecordsFiles(
  migrations: readonly ReplayFile[],
  history: ProbeReport['history']
): CheckResult {
  const name = HISTORY_CHECK;
  if (history === undefined) {
    return {
      name,
      passed: false,
      notes: 'the probe returned no migration history',
    };
  }
  if ('error' in history) {
    return {
      name,
      passed: false,
      notes: `could not read the migration history: ${history.error}`,
    };
  }
  const recorded = new Set(history.versions);
  const unrecorded = migrations.filter(({ name: file }) => {
    const version = versionOf(file);
    return version === undefined || !recorded.has(version);
  });
  return unrecorded.length === 0
    ? { name, passed: true, notes: `${migrations.length} files recorded` }
    : {
        name,
        passed: false,
        notes: `not recorded in the migration history: ${unrecorded.map(({ name: file }) => file).join(', ')}`,
      };
}
