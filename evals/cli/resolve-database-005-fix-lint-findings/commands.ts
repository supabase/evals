import type { CheckResult } from '@supabase-evals/core';
import {
  invocationSubcommand,
  invocationVerb,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';

export const RAN_CHECKS_CHECK = 'ran supabase db lint or db advisors';

export function countDatabaseCheckRuns(
  invocations: readonly SupabaseInvocation[]
): { lint: number; advisors: number } {
  const counts = { lint: 0, advisors: 0 };
  for (const invocation of invocations) {
    if (invocationVerb(invocation) !== 'db') continue;
    const subcommand = invocationSubcommand(invocation);
    if (subcommand === 'lint') counts.lint++;
    if (subcommand === 'advisors') counts.advisors++;
  }
  return counts;
}

export function checkRanDatabaseChecks(counts: {
  lint: number;
  advisors: number;
}): CheckResult {
  return {
    name: RAN_CHECKS_CHECK,
    passed: counts.lint + counts.advisors > 0,
    notes: `db lint ×${counts.lint}, db advisors ×${counts.advisors}`,
  };
}
