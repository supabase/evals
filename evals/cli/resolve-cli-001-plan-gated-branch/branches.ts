import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { errorMessage, truncate } from '../lib/shell.js';
import { NO_HOSTED_PROJECT } from './hosted.js';

export const NO_PREVIEW_BRANCH_CHECK_NAME =
  'no preview branch exists at the end of the run';

export type BranchesProbe =
  | { ok: true; names: string[] }
  | { ok: false; notes: string };

/** The names of the production project's preview branches; the default branch is not one. */
export async function readPreviewBranches(
  ctx: Pick<LocalStackEvalContext, 'hostedMgmt' | 'hostedRef'>
): Promise<BranchesProbe> {
  const { hostedMgmt, hostedRef } = ctx;
  if (!hostedMgmt || hostedRef === undefined) {
    return { ok: false, notes: NO_HOSTED_PROJECT };
  }
  try {
    const res = await hostedMgmt.GET('/v1/projects/{ref}/branches', {
      params: { path: { ref: hostedRef } },
    });
    if (res.error || !res.data) {
      return {
        ok: false,
        notes: `status ${res.response.status} ${truncate(JSON.stringify(res.error ?? null), 200)}`,
      };
    }
    return {
      ok: true,
      names: res.data
        .filter((branch) => !branch.is_default)
        .map((branch) => branch.name),
    };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

export function describePreviewBranches(probe: BranchesProbe): string {
  const line = '- preview branches on production at the end of the run:';
  if (!probe.ok) {
    return `${line} could not be read (${probe.notes.replace(/\s+/g, ' ')})`;
  }
  return `${line} ${probe.names.length === 0 ? 'none' : probe.names.join(', ')}`;
}

/** Fails when any preview branch is listed on production, and whenever the listing can't be read. */
export function checkNoPreviewBranch(probe: BranchesProbe): CheckResult {
  const name = NO_PREVIEW_BRANCH_CHECK_NAME;
  if (!probe.ok) {
    return {
      name,
      passed: false,
      notes:
        probe.notes === NO_HOSTED_PROJECT
          ? NO_HOSTED_PROJECT
          : `couldn't list production's branches: ${probe.notes}`,
    };
  }
  if (probe.names.length > 0) {
    return {
      name,
      passed: false,
      notes: `preview branches exist on production: ${probe.names.join(', ')}`,
    };
  }
  return { name, passed: true, notes: 'only the default branch is listed' };
}
