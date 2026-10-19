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

// `invocationVerb` is the only positional parser cli-invocations exposes, so the
// token that made it answer `gen` is dropped to read the next positional.
function isGenTypes(invocation: SupabaseInvocation): boolean {
  if (invocationVerb(invocation) !== 'gen') return false;
  const { argv } = invocation;
  const verbAt = argv.findIndex(
    (_, index) =>
      index > 0 &&
      invocationVerb({ ...invocation, argv: argv.slice(0, index + 1) }) !==
        undefined
  );
  return (
    invocationVerb({
      ...invocation,
      argv: argv.filter((_, index) => index !== verbAt),
    }) === 'types'
  );
}

/** Direct `supabase gen types` invocations and the distinct database sources they named. */
export function countGenTypesRuns(
  invocations: readonly SupabaseInvocation[]
): GenTypesRuns {
  const runs = invocations.filter(isGenTypes);
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
    genTypes: GenTypesRuns;
    stack: StackProbe;
    analysis: ProjectAnalysis;
    cli: CliFacts;
  }
): Promise<CheckResult> {
  const { commands, genTypes, stack, analysis } = facts;
  const { versions, cliOverride } = facts.cli;

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
    genTypesRuns: await safely(() => genTypes.runs),
    genTypesSources: await safely(() => genTypes.sources),
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
