import type {
  CheckResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import {
  invocationVerb,
  listCliOverrides,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { findCliDetourCommands } from '../lib/detours.js';
import { readCliVersions, safely } from '../lib/metrics.js';
import type { StackProbe } from '../lib/stack.js';
import type { ProjectAnalysis } from './typecheck.js';

export type GenTypesRuns = { runs: number; sources: string[] };

const GEN_TYPES_SOURCE_FLAGS = [
  ['--local', 'local'],
  ['--db-url', 'db-url'],
  ['--linked', 'linked'],
  ['--project-id', 'project-id'],
] as const;

function genTypesSource(invocation: SupabaseInvocation): string {
  const match = GEN_TYPES_SOURCE_FLAGS.find(([flag]) =>
    invocation.argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`))
  );
  return match?.[1] ?? 'none';
}

/** Executed `supabase gen types` runs and the distinct database sources they named. */
export function countGenTypesRuns(
  invocations: readonly SupabaseInvocation[]
): GenTypesRuns {
  const runs = invocations.filter(
    (invocation) =>
      invocationVerb(invocation) === 'gen' && invocation.argv.includes('types')
  );
  return { runs: runs.length, sources: [...new Set(runs.map(genTypesSource))] };
}

export type CliFacts = {
  versions: Awaited<ReturnType<typeof readCliVersions>> | null;
  cliOverride: string[] | null;
};

export async function readCliFacts(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  marker: LocalStackEnvironmentMarker | undefined,
  invocations: readonly SupabaseInvocation[]
): Promise<CliFacts> {
  const versions = await safely(() => readCliVersions(ctx, marker));
  return {
    versions,
    cliOverride: await safely(() =>
      versions === null
        ? null
        : listCliOverrides(
            invocations,
            versions.cliVersion,
            versions.cliVersionAfterRun ?? versions.cliVersion
          )
    ),
  };
}

export async function checkMetrics(
  marker: LocalStackEnvironmentMarker | undefined,
  facts: {
    commands: readonly string[];
    invocations: readonly SupabaseInvocation[];
    stack: StackProbe;
    analysis: ProjectAnalysis;
    cli: CliFacts;
  }
): Promise<CheckResult> {
  const { commands, invocations, stack, analysis } = facts;
  const { versions, cliOverride } = facts.cli;
  const genTypes = await safely(() => countGenTypesRuns(invocations));

  const metrics = {
    cliVersion: versions?.cliVersion ?? null,
    ...(versions?.cliVersionAfterRun === undefined
      ? {}
      : { cliVersionAfterRun: versions.cliVersionAfterRun }),
    cliOverride,
    channel: marker?.channel ?? 'pinned',
    stack: await safely(() =>
      stack.ok
        ? {
            backend: stack.backend,
            runtime: stack.runtime,
            relocatedHome: stack.relocatedHome ?? null,
          }
        : { backend: 'none', runtime: 'none', relocatedHome: null }
    ),
    genTypesRuns: genTypes?.runs ?? null,
    genTypesSources: genTypes?.sources ?? null,
    typesModules: await safely(() =>
      analysis.ok ? analysis.typesModules.map((module) => module.path) : null
    ),
    diagnostics: await safely(() =>
      analysis.ok ? analysis.diagnostics.length : null
    ),
    suppressions: await safely(() =>
      analysis.ok ? analysis.suppressions.length : null
    ),
    // Regex diagnostic — can disagree with the judges, never asserted against.
    cliDetours: await safely(() => findCliDetourCommands(commands).length),
  };

  return { name: 'metrics', passed: true, notes: JSON.stringify(metrics) };
}
