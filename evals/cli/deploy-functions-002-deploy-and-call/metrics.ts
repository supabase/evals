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
const DEPLOY_FLAGS = [
  '--use-api',
  '--use-docker',
  '--no-verify-jwt',
  '--project-ref',
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

/** Supabase invocations by subcommand: the deploy journey's own commands, anything else under `other`. */
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

/** How many `functions deploy` invocations carried each of the flags that change how a deploy bundles or secures a function. */
export function deployFlags(
  invocations: readonly SupabaseInvocation[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { argv } of invocations) {
    if (commandKey(argv) !== 'functions deploy') continue;
    for (const flag of DEPLOY_FLAGS) {
      if (argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`))) {
        counts[flag] = (counts[flag] ?? 0) + 1;
      }
    }
  }
  return counts;
}

export async function checkMetrics(
  marker: LocalStackEnvironmentMarker | undefined,
  facts: {
    commands: readonly string[];
    invocations: readonly SupabaseInvocation[];
    hosted: boolean;
    deployment: DeploymentProbe;
    cli: CliFacts;
  }
): Promise<CheckResult> {
  const { commands, invocations, hosted, deployment, cli } = facts;
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
    deployedVerifyJwt: await safely(() => deployed()?.verifyJwt ?? null),
    cliCommands: await safely(() => countCliCommands(invocations)),
    deployFlags: await safely(() => deployFlags(invocations)),
    cliDetours: await safely(() => findCliDetourCommands(commands).length),
  };

  return { name: 'metrics', passed: true, notes: JSON.stringify(metrics) };
}
