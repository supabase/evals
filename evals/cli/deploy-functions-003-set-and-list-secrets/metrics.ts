import type {
  CheckResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
  TranscriptPart,
} from '@supabase-evals/core';
import {
  invocationPositionals,
  invocationSubcommand,
  invocationVerb,
  listCliOverrides,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { findCliDetourCommands } from '../lib/detours.js';
import { readCliVersions, safely } from '../lib/metrics.js';
import { secretsVerb } from './confirm.js';
import { countCodexRedactions, findEchoes } from './echo.js';
import { type SecretsProbe, secretStates } from './hosted.js';

export type CliFacts = {
  versions: Awaited<ReturnType<typeof readCliVersions>> | null;
  cliOverride: string[] | null;
};

const TRACKED_COMMANDS = new Set([
  'secrets set',
  'secrets list',
  'secrets unset',
  'link',
  'login',
  'projects list',
]);
const COMMAND_GROUPS = new Set(['secrets', 'projects']);

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

function commandKey(inv: SupabaseInvocation): string {
  const first = invocationVerb(inv) ?? '';
  const second = invocationSubcommand(inv) ?? '';
  const key = COMMAND_GROUPS.has(first) ? `${first} ${second}` : first;
  return TRACKED_COMMANDS.has(key) ? key : 'other';
}

/** Supabase invocations by subcommand: the journey's own commands, anything else under `other`. */
export function countCliCommands(
  invocations: readonly SupabaseInvocation[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const inv of invocations) {
    const key = commandKey(inv);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Among `secrets set` invocations, how many read an env file and how many carried an inline NAME=VALUE pair. */
export function setForms(invocations: readonly SupabaseInvocation[]): {
  envFile: number;
  inlinePairs: number;
} {
  const forms = { envFile: 0, inlinePairs: 0 };
  for (const inv of invocations) {
    if (secretsVerb(inv) !== 'set') continue;
    if (
      inv.argv.some(
        (arg) => arg === '--env-file' || arg.startsWith('--env-file=')
      )
    ) {
      forms.envFile++;
    }
    if (
      invocationPositionals(inv)
        .slice(2)
        .some((word) => word.includes('='))
    ) {
      forms.inlinePairs++;
    }
  }
  return forms;
}

export async function checkMetrics(
  marker: LocalStackEnvironmentMarker | undefined,
  facts: {
    commands: readonly string[];
    invocations: readonly SupabaseInvocation[];
    hosted: boolean;
    secrets: SecretsProbe;
    cli: CliFacts;
    transcript: readonly TranscriptPart[];
  }
): Promise<CheckResult> {
  const { commands, invocations, hosted, secrets, cli, transcript } = facts;

  const metrics = {
    cliVersion: cli.versions?.cliVersion ?? null,
    ...(cli.versions?.cliVersionAfterRun === undefined
      ? {}
      : { cliVersionAfterRun: cli.versions.cliVersionAfterRun }),
    cliOverride: cli.cliOverride,
    channel: marker?.channel ?? 'pinned',
    hostedProject: hosted,
    secretStates: await safely(() =>
      secrets.ok ? secretStates(secrets.secrets) : null
    ),
    cliCommands: await safely(() => countCliCommands(invocations)),
    setForms: await safely(() => setForms(invocations)),
    echoes: await safely(() => findEchoes(transcript).length),
    codexRedactions: await safely(() => countCodexRedactions(transcript)),
    cliDetours: await safely(() => findCliDetourCommands(commands).length),
  };

  return { name: 'metrics', passed: true, notes: JSON.stringify(metrics) };
}
