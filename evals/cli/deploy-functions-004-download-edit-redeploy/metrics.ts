import * as fs from 'node:fs';
import * as path from 'node:path';
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
import type { DeploymentProbe } from './hosted.js';
import { FUNCTION_SLUG } from './seed.js';

export type CliFacts = {
  versions: Awaited<ReturnType<typeof readCliVersions>> | null;
  cliOverride: string[] | null;
};

const TRACKED_COMMANDS = new Set([
  'functions deploy',
  'functions serve',
  'functions list',
  'functions new',
  'functions download',
  'link',
  'login',
  'projects list',
  'projects api-keys',
  'secrets',
  'start',
  'status',
]);
const COMMAND_GROUPS = new Set(['functions', 'projects']);
const VALUE_FLAGS = new Set([
  '--workdir',
  '--profile',
  '--network-id',
  '-o',
  '--output',
  '--output-format',
  '--dns-resolver',
  '--project-ref',
  '--import-map',
  '-j',
  '--jobs',
  '--log-level',
  '--agent',
]);
const DOWNLOAD_FLAGS = [
  '--use-api',
  '--use-docker',
  '--legacy-bundle',
  '--project-ref',
  '--remote',
];
const DEPLOY_FLAGS = [
  '--use-api',
  '--use-docker',
  '--no-verify-jwt',
  '--project-ref',
  '--remote',
  '--prune',
];

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

function subcommandWords(argv: readonly string[]): string[] {
  const words: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    if (!argv[i].startsWith('-')) words.push(argv[i]);
    else if (VALUE_FLAGS.has(argv[i])) i++;
  }
  return words;
}

function commandKey(argv: readonly string[]): string {
  const [first = '', second = ''] = subcommandWords(argv);
  const key = COMMAND_GROUPS.has(first) ? `${first} ${second}` : first;
  return TRACKED_COMMANDS.has(key) ? key : 'other';
}

/** Supabase invocations by subcommand: the journey's own commands, anything else under `other`. */
export function countCliCommands(
  invocations: readonly SupabaseInvocation[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { argv } of invocations) {
    const key = commandKey(argv);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function flagCounts(
  invocations: readonly SupabaseInvocation[],
  command: string,
  flags: readonly string[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { argv } of invocations) {
    if (commandKey(argv) !== command) continue;
    for (const flag of flags) {
      if (argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`))) {
        counts[flag] = (counts[flag] ?? 0) + 1;
      }
    }
  }
  return counts;
}

/** How many `functions download` invocations carried each flag that changes how the source is fetched or which project it comes from. */
export function downloadFlags(
  invocations: readonly SupabaseInvocation[]
): Record<string, number> {
  return flagCounts(invocations, 'functions download', DOWNLOAD_FLAGS);
}

/** How many `functions deploy` invocations carried each flag that changes how a deploy bundles or secures a function. */
export function deployFlags(
  invocations: readonly SupabaseInvocation[]
): Record<string, number> {
  return flagCounts(invocations, 'functions deploy', DEPLOY_FLAGS);
}

/** Whether the agent left the function's source in the workspace; null when the workspace can't be read. */
export function readLocalSource(hostWorkspace: string): boolean | null {
  try {
    return fs.existsSync(
      path.join(
        hostWorkspace,
        'supabase',
        'functions',
        FUNCTION_SLUG,
        'index.ts'
      )
    );
  } catch {
    return null;
  }
}

export async function checkMetrics(
  marker: LocalStackEnvironmentMarker | undefined,
  facts: {
    commands: readonly string[];
    invocations: readonly SupabaseInvocation[];
    hosted: boolean;
    deployment: DeploymentProbe;
    cli: CliFacts;
    localSource: boolean | null;
  }
): Promise<CheckResult> {
  const { commands, invocations, hosted, deployment, cli, localSource } = facts;
  const deployed = () => (deployment.ok ? deployment.deployed : null);
  const metrics = {
    cliVersion: cli.versions?.cliVersion ?? null,
    ...(cli.versions?.cliVersionAfterRun === undefined
      ? {}
      : { cliVersionAfterRun: cli.versions.cliVersionAfterRun }),
    cliOverride: cli.cliOverride,
    channel: marker?.channel ?? 'pinned',
    hostedProject: hosted,
    deployedStatus: await safely(() => deployed()?.status ?? null),
    deployedVersion: await safely(() => deployed()?.version ?? null),
    deployedVerifyJwt: await safely(() => deployed()?.verifyJwt ?? null),
    localSourcePresent: localSource,
    cliCommands: await safely(() => countCliCommands(invocations)),
    downloadFlags: await safely(() => downloadFlags(invocations)),
    deployFlags: await safely(() => deployFlags(invocations)),
    cliDetours: await safely(() => findCliDetourCommands(commands).length),
  };
  return { name: 'metrics', passed: true, notes: JSON.stringify(metrics) };
}
