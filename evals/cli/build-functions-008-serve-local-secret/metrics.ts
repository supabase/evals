import fs from 'node:fs';
import path from 'node:path';
import type {
  CheckResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import {
  listCliOverrides,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { findCliDetourCommands } from '../lib/detours.js';
import { readCliVersions, safely } from '../lib/metrics.js';
import type { StackProbe } from '../lib/stack.js';
import {
  FUNCTIONS_PATH,
  isFunctionsServe,
  lastServeInvocation,
  type FunctionProbe,
} from './probe.js';
import type { SecretScan } from './secret.js';

export type CliFacts = {
  versions: Awaited<ReturnType<typeof readCliVersions>> | null;
  cliOverride: string[];
};

export async function readCliFacts(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  marker: LocalStackEnvironmentMarker | undefined,
  invocations: readonly SupabaseInvocation[]
): Promise<CliFacts> {
  const versions = await safely(() => readCliVersions(ctx, marker));
  const cliOverride = await safely(() =>
    versions === null
      ? []
      : listCliOverrides(
          invocations,
          versions.cliVersion,
          versions.cliVersionAfterRun ?? versions.cliVersion
        )
  );
  return { versions, cliOverride: cliOverride ?? [] };
}

/** Commands that mention the local functions endpoint, however they reach it. */
export function countAgentCalls(commands: readonly string[]): number {
  return commands.filter((command) => command.includes(FUNCTIONS_PATH)).length;
}

/** Function directories under `supabase/functions`, leaving out shared (`_`) and hidden (`.`) ones. */
export function listFunctionDirs(root: string): string[] {
  const dir = path.join(root, 'supabase', 'functions');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        !entry.name.startsWith('_')
    )
    .map(({ name }) => name)
    .sort();
}

function describeReplay(
  probe: FunctionProbe
): 'not-run' | 'accepted' | 'not-accepted' {
  if (!probe.replay.ran) return 'not-run';
  return probe.accepted?.servedBy === 'replay' ? 'accepted' : 'not-accepted';
}

function listSecretFiles(scan: SecretScan): string[] | null {
  return scan.ok
    ? scan.hits.map(({ file, ignored }) =>
        ignored ? file : `${file} (committed)`
      )
    : null;
}

export async function checkMetrics(
  marker: LocalStackEnvironmentMarker | undefined,
  facts: {
    commands: readonly string[];
    invocations: readonly SupabaseInvocation[];
    stack: StackProbe;
    probe: FunctionProbe;
    scan: SecretScan;
    cli: CliFacts;
    functionDirs: readonly string[];
  }
): Promise<CheckResult> {
  const { commands, invocations, stack, probe, scan, cli, functionDirs } =
    facts;
  const { versions, cliOverride } = cli;

  const metrics = {
    cliVersion: versions?.cliVersion ?? null,
    ...(versions?.cliVersionAfterRun === undefined
      ? {}
      : { cliVersionAfterRun: versions.cliVersionAfterRun }),
    cliOverride,
    channel: marker?.channel ?? 'pinned',
    docker: marker?.docker ?? null,
    stack: await safely(() =>
      stack.ok
        ? {
            backend: stack.backend,
            runtime: stack.runtime,
            relocatedHome: stack.relocatedHome ?? null,
          }
        : { backend: 'none', runtime: 'none', relocatedHome: null }
    ),
    servedBy: await safely(() => probe.accepted?.servedBy ?? 'none'),
    authVariant: await safely(() => probe.accepted?.variant ?? null),
    openWithoutKeys: await safely(() => probe.accepted?.variant === 'none'),
    serveInvocations: await safely(
      () => invocations.filter(isFunctionsServe).length
    ),
    lastServe: await safely(
      () => lastServeInvocation(invocations)?.argv.slice(1).join(' ') ?? null
    ),
    replay: await safely(() => describeReplay(probe)),
    secretFiles: await safely(() => listSecretFiles(scan)),
    functionDirs,
    agentCalls: await safely(() => countAgentCalls(commands)),
    // Regex diagnostic — can disagree with the judges, never asserted against.
    cliDetours: await safely(() => findCliDetourCommands(commands).length),
  };

  return { name: 'metrics', passed: true, notes: JSON.stringify(metrics) };
}
