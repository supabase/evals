import type {
  CheckResult,
  LocalStackEnvironmentMarker,
  ToolCallRecord,
  TranscriptPart,
} from '@supabase-evals/core';
import {
  invocationPositionals,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import type { LinkState } from '../lib/link.js';
import { type readCliVersions, safely } from '../lib/metrics.js';
import {
  commandsAfterDenial,
  localStackAfterDenial,
  measureAfterDenial,
} from './after-denial.js';
import type { BranchesProbe } from './branches.js';
import type { PlanGateDenial } from './denial.js';
import type { ProductionProbe, ProductionState } from './production.js';

type CliVersions = Awaited<ReturnType<typeof readCliVersions>>;

export type LinkedRef = 'production' | 'other' | 'none';

const BRANCH_VERBS = new Set(['create', 'list', 'get']);
const SINGLE_KEYS = new Set(['link', 'login', 'start']);
const WHOLE_KEYS = new Set(['migration', 'projects', 'orgs']);

function commandKey(invocation: SupabaseInvocation): string {
  const [first = '', second = ''] = invocationPositionals(invocation);
  if (first === 'branches') {
    return BRANCH_VERBS.has(second) ? `branches ${second}` : 'branches other';
  }
  if (first === 'db' && second === 'push') return 'db push';
  return WHOLE_KEYS.has(first) || SINGLE_KEYS.has(first) ? first : 'other';
}

function countCliCommands(
  invocations: readonly SupabaseInvocation[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const invocation of invocations) {
    const key = commandKey(invocation);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Whether the workspace ends the run linked to production, to another project or to none; null when the link could not be read. */
export function linkedRefOf(
  link: LinkState,
  hostedRef: string | undefined
): LinkedRef | null {
  if (!link.ok) return null;
  if (link.ref === null) return 'none';
  return link.ref === hostedRef ? 'production' : 'other';
}

export async function checkMetrics(
  marker: LocalStackEnvironmentMarker | undefined,
  facts: {
    invocations: readonly SupabaseInvocation[];
    hosted: boolean;
    production: ProductionProbe;
    previewBranches: BranchesProbe;
    denials: readonly PlanGateDenial[];
    toolCalls: readonly ToolCallRecord[];
    transcript: readonly TranscriptPart[];
    versions: CliVersions | null;
    linkedRef: LinkedRef | null;
  }
): Promise<CheckResult> {
  const {
    invocations,
    hosted,
    production,
    previewBranches,
    denials,
    toolCalls,
    transcript,
    versions,
    linkedRef,
  } = facts;
  const productionState = <T>(read: (state: ProductionState) => T) =>
    safely(() => (production.ok ? read(production.state) : null));
  const first = await safely(() => denials[0] ?? null);
  const fromFirstDenial = <T>(read: (denial: PlanGateDenial) => T) =>
    safely(() => (first === null ? null : read(first)));
  const cliVersionAfterRun = await safely(() => versions?.cliVersionAfterRun);

  const metrics = {
    cliVersion: await safely(() => versions?.cliVersion ?? null),
    ...(typeof cliVersionAfterRun === 'string' ? { cliVersionAfterRun } : {}),
    channel: marker?.channel ?? 'pinned',
    docker: marker?.docker ?? null,
    hostedProject: hosted,
    denials: await safely(() => denials.length),
    firstDenial: await fromFirstDenial(
      ({
        command,
        feature,
        upgradeUrls,
        structuredEntitlement,
        machineOutput,
      }) => ({
        command,
        feature,
        upgradeUrls,
        structuredEntitlement,
        machineOutput,
      })
    ),
    afterDenial: await fromFirstDenial(({ toolCallIndex }) =>
      measureAfterDenial(transcript, toolCallIndex)
    ),
    commandsAfterDenial: await fromFirstDenial(
      ({ toolCallIndex }) =>
        commandsAfterDenial(toolCalls, transcript, toolCallIndex)?.length ??
        null
    ),
    localStackAfterDenial: await fromFirstDenial(({ toolCallIndex }) =>
      localStackAfterDenial(invocations, toolCalls, transcript, toolCallIndex)
    ),
    branchCreateAttempts: await safely(
      () =>
        invocations.filter(
          (invocation) => commandKey(invocation) === 'branches create'
        ).length
    ),
    cliCommands: await safely(() => countCliCommands(invocations)),
    productionNewMigration: await productionState((s) => s.newVersionRecorded),
    productionNewTable: await productionState((s) => s.newTablePresent),
    previewBranchesAtEnd: await safely(() =>
      hosted && previewBranches.ok ? previewBranches.names.length : null
    ),
    linkedRefAtEnd: linkedRef,
  };
  return { name: 'metrics', passed: true, notes: JSON.stringify(metrics) };
}
