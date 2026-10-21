import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import {
  type CommandEntry,
  invocationPositionals,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { errorMessage, truncate } from '../lib/shell.js';
import { NO_HOSTED_PROJECT } from './hosted.js';

export type BranchSummary = {
  name: string;
  projectRef: string;
  isDefault: boolean;
  status: string;
  createdAtMs: number | undefined;
  deletionScheduledAt?: string;
};

export type BranchesProbe =
  | { ok: true; branches: BranchSummary[] }
  | { ok: false; notes: string };

export async function readBranches(
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
        notes: `could not list branches: status ${res.response.status} ${truncate(JSON.stringify(res.error ?? null), 200)}`,
      };
    }
    return {
      ok: true,
      branches: res.data.map((branch) => {
        const createdAtMs = Date.parse(branch.created_at ?? '');
        return {
          name: branch.name,
          projectRef: branch.project_ref,
          isDefault: branch.is_default,
          status: branch.status,
          createdAtMs: Number.isNaN(createdAtMs) ? undefined : createdAtMs,
          ...(branch.deletion_scheduled_at
            ? { deletionScheduledAt: branch.deletion_scheduled_at }
            : {}),
        };
      }),
    };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

/** Non-default branches created since the session started, plus any whose age is unknown and so can't be ruled out. */
export function runBranches(
  branches: readonly BranchSummary[],
  sessionStartMs: number
): BranchSummary[] {
  return branches.filter(
    (branch) =>
      !branch.isDefault &&
      (branch.createdAtMs === undefined || branch.createdAtMs >= sessionStartMs)
  );
}

export function splitRunBranches(
  branches: readonly BranchSummary[],
  sessionStartMs: number
): { running: BranchSummary[]; scheduled: BranchSummary[] } {
  const mine = runBranches(branches, sessionStartMs);
  return {
    running: mine.filter((branch) => !branch.deletionScheduledAt),
    scheduled: mine.filter((branch) => branch.deletionScheduledAt),
  };
}

export function countBranchCreates(
  invocations: readonly SupabaseInvocation[],
  entries: readonly CommandEntry[]
): number {
  return invocations.filter((invocation) => {
    const [group, verb] = invocationPositionals(invocation);
    return (
      group === 'branches' &&
      verb === 'create' &&
      entries[invocation.commandIndex]?.failed !== true
    );
  }).length;
}

const describeBranch = (branch: BranchSummary) =>
  `${branch.name} (${branch.projectRef}, ${branch.status}${branch.deletionScheduledAt ? `, deletion scheduled ${branch.deletionScheduledAt}` : ''})`;

export function checkBranchCleanedUp(
  probe: BranchesProbe,
  sessionStartMs: number | null,
  creates: number
): CheckResult {
  const name = 'the preview branch was cleaned up';
  if (!probe.ok) return { name, passed: false, notes: probe.notes };
  if (sessionStartMs === null) {
    return {
      name,
      passed: false,
      notes:
        "can't tell this run's branches from older ones: session start time unavailable",
    };
  }
  const { running, scheduled } = splitRunBranches(
    probe.branches,
    sessionStartMs
  );
  if (creates === 0 && running.length + scheduled.length === 0) {
    return {
      name,
      passed: false,
      notes:
        'no preview branch was created in this run, so there was nothing to clean up',
    };
  }
  if (running.length > 0) {
    return {
      name,
      passed: false,
      notes: `still running: ${running.map(describeBranch).join(', ')}`,
    };
  }
  return {
    name,
    passed: true,
    notes: `none of this run's branches is left running${
      scheduled.length > 0
        ? `; scheduled for deletion: ${scheduled.map((branch) => branch.name).join(', ')}`
        : ''
    }`,
  };
}

export function describeBranches(
  probe: BranchesProbe,
  sessionStartMs: number | null
): string[] {
  if (!probe.ok) return [`- preview branches: unavailable (${probe.notes})`];
  if (sessionStartMs === null) {
    return [
      "- preview branches: this run's branches can't be told from older ones because the session start time is unavailable",
    ];
  }
  const listed = runBranches(probe.branches, sessionStartMs).map(
    describeBranch
  );
  return [
    `- preview branches this run created that are still listed: ${listed.length > 0 ? listed.join(', ') : 'none'}`,
  ];
}
