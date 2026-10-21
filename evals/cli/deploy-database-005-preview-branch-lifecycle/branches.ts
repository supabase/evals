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
const PROJECT_REF_KEY = /(?<!\w)project_ref"?\s*:\s*"?([a-z]{20})\b/g;

const outputOf = (record: ToolCallRecord | undefined): string => {
  const output = record?.result ?? record?.error;
  if (output === undefined) return '';
  return typeof output === 'string' ? output : JSON.stringify(output);
};

const firstRef = (text: string, productionRef: string | undefined) =>
  text.match(PROJECT_REF_TOKEN)?.find((ref) => ref !== productionRef);

/** The create's own ref: the ID after its `Created preview branch` line, else a `project_ref` value, else the first ref anywhere. */
function createdRef(
  output: string,
  productionRef: string | undefined
): string | undefined {
  const created = CREATED_OUTPUT.exec(output);
  if (created) {
    return firstRef(
      output.slice(created.index + created[0].length),
      productionRef
    );
  }
  const keyed = [...output.matchAll(PROJECT_REF_KEY)]
    .map((match) => match[1])
    .find((ref) => ref !== productionRef);
  return keyed ?? firstRef(output, productionRef);
}

/** A `branches create` counts when its output reports a branch; a call that didn't fail also counts when it prints a non-production ref. */
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
    const failed = entries[invocation.commandIndex]?.failed === true;
    const output = outputOf(calls[invocation.commandIndex]);
    const reported = CREATED_OUTPUT.test(output);
    if (failed && !reported) continue;
    const ref = createdRef(output, productionRef);
    if (!reported && ref === undefined) continue;
    creates += 1;
    if (ref !== undefined) refs.add(ref);
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
