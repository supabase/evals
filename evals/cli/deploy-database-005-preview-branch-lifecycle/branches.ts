import type {
  CheckResult,
  LocalStackEvalContext,
  ToolCallRecord,
} from '@supabase-evals/core';
import {
  type CommandEntry,
  invocationPositionals,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { commandToolCalls } from '../lib/detours.js';
import { errorMessage, truncate } from '../lib/shell.js';
import { NO_HOSTED_PROJECT } from './hosted.js';

export type BranchSummary = {
  name: string;
  projectRef: string;
  isDefault: boolean;
  status: string;
  createdAtMs: number | undefined;
  deletionScheduledAt?: string;
  previewProjectStatus?: string;
};

export type BranchCreates = { creates: number; refs: string[] };

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
          ...(branch.preview_project_status
            ? { previewProjectStatus: branch.preview_project_status }
            : {}),
        };
      }),
    };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

const isGone = (branch: BranchSummary) =>
  Boolean(branch.deletionScheduledAt) ||
  branch.previewProjectStatus === 'REMOVED';

/** Non-default branches created since the session started, of unknown age, or whose ref a create printed. */
export function runBranches(
  branches: readonly BranchSummary[],
  sessionStartMs: number,
  refs: readonly string[]
): BranchSummary[] {
  return branches.filter(
    (branch) =>
      !branch.isDefault &&
      (branch.createdAtMs === undefined ||
        branch.createdAtMs >= sessionStartMs ||
        refs.includes(branch.projectRef))
  );
}

export function splitRunBranches(
  branches: readonly BranchSummary[],
  sessionStartMs: number,
  refs: readonly string[]
): { running: BranchSummary[]; scheduled: BranchSummary[] } {
  const mine = runBranches(branches, sessionStartMs, refs);
  return {
    running: mine.filter((branch) => !isGone(branch)),
    scheduled: mine.filter(isGone),
  };
}

const CREATED_OUTPUT = /Created preview branch/i;
const PROJECT_REF_TOKEN = /\b[a-z]{20}\b/g;

const outputOf = (record: ToolCallRecord | undefined): string => {
  const result = record?.result;
  if (result === undefined) return '';
  return typeof result === 'string' ? result : JSON.stringify(result);
};

/** A `branches create` counts only when its tool call didn't fail and its own output reports a branch or prints a non-production project ref. */
export function readBranchCreates(
  invocations: readonly SupabaseInvocation[],
  entries: readonly CommandEntry[],
  toolCalls: readonly ToolCallRecord[],
  productionRef: string | undefined
): BranchCreates {
  const calls = commandToolCalls(toolCalls);
  const refs = new Set<string>();
  let creates = 0;
  for (const invocation of invocations) {
    const [group, verb] = invocationPositionals(invocation);
    if (group !== 'branches' || verb !== 'create') continue;
    if (entries[invocation.commandIndex]?.failed === true) continue;
    const output = outputOf(calls[invocation.commandIndex]);
    const found = (output.match(PROJECT_REF_TOKEN) ?? []).filter(
      (ref) => ref !== productionRef
    );
    if (found.length === 0 && !CREATED_OUTPUT.test(output)) continue;
    creates += 1;
    for (const ref of found) refs.add(ref);
  }
  return { creates, refs: [...refs] };
}

const describeBranch = (branch: BranchSummary) =>
  `${branch.name} (${branch.projectRef}, ${branch.status}${branch.previewProjectStatus ? `, preview project status ${branch.previewProjectStatus}` : ''}${branch.deletionScheduledAt ? `, deletion scheduled ${branch.deletionScheduledAt}` : ''})`;

export function checkBranchCleanedUp(
  probe: BranchesProbe,
  sessionStartMs: number | null,
  evidence: BranchCreates
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
    sessionStartMs,
    evidence.refs
  );
  if (evidence.creates === 0 && running.length + scheduled.length === 0) {
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
  sessionStartMs: number | null,
  refs: readonly string[]
): string[] {
  if (!probe.ok) return [`- preview branches: unavailable (${probe.notes})`];
  if (sessionStartMs === null) {
    return [
      "- preview branches: this run's branches can't be told from older ones because the session start time is unavailable",
    ];
  }
  const listed = runBranches(probe.branches, sessionStartMs, refs).map(
    describeBranch
  );
  return [
    `- this run's preview branches still listed: ${listed.length > 0 ? listed.join(', ') : 'none (expected after cleanup; this does not say whether one was created)'}`,
  ];
}
