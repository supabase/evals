import type { CheckResult } from '@supabase-evals/core';
import type { ConfigCounts } from './metrics.js';

export const CONFIG_PUSH_CHECK_NAME = 'the agent ran supabase config push';

/** Counts a push that errored or skipped its change; the project check scores whether it landed. */
export function checkConfigPushed(
  counts: Pick<ConfigCounts, 'configPush'>
): CheckResult {
  const name = CONFIG_PUSH_CHECK_NAME;
  return counts.configPush >= 1
    ? { name, passed: true }
    : { name, passed: false, notes: 'no supabase config push ran' };
}
