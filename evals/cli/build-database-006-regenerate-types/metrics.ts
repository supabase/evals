import type {
  CheckResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
  ToolCallRecord,
} from '@supabase-evals/core';
import {
  invocationVerb,
  listCliOverrides,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import {
  commandToolCalls,
  extractCommandEntries,
  findCliDetourCommands,
} from '../lib/detours.js';
import { readCliVersions, safely } from '../lib/metrics.js';
import type { StackProbe } from '../lib/stack.js';
import type { MigrationEvidenceSource } from './schema.js';
import type { ProjectAnalysis } from './typecheck.js';

export const OUTPUT_FAILURE =
  /"_tag"\s*:\s*"Error"|\berror:|error running container|Try rerunning the command with --debug/i;

/** Whether the tool call exited zero and its output holds no CLI error. */
function toolCallSucceeded(call: ToolCallRecord | undefined): boolean {
  return (
    call?.error === undefined &&
    typeof call?.result === 'string' &&
    !OUTPUT_FAILURE.test(call.result)
  );
}

const CONNECT_LINE = /^Connecting to /m;
const GENERATED_TYPES =
  /Generated TypeScript is unformatted|export type Database/;

function printedTypesAfterConnecting(error: string): boolean {
  const connected = error.search(CONNECT_LINE);
  return (
    connected !== -1 &&
    !OUTPUT_FAILURE.test(error) &&
    GENERATED_TYPES.test(error.slice(connected))
  );
}

/** Whether a gen types run succeeded: its tool call exited zero, or errored on a later command after the output shows the generated types. */
export function genTypesRunSucceeded(
  call: ToolCallRecord | undefined
): boolean {
  return (
    toolCallSucceeded(call) ||
    (typeof call?.error === 'string' && printedTypesAfterConnecting(call.error))
  );
}

export type GenTypesRuns = {
  runs: number;
  sources: string[];
  /** Runs whose tool call errored without showing the generated types; `silent` means the error text was empty. */
  failed: Array<{ command: string; silent: boolean }>;
  /** Runs that succeeded; `laterCommandFailed` means the tool call errored on a command after gen types. */
  succeeded: Array<{ command: string; laterCommandFailed: boolean }>;
};

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
// token that made it answer the verb is dropped to read the next positional.
export function subcommand(invocation: SupabaseInvocation): string | undefined {
  const { argv } = invocation;
  const verbAt = argv.findIndex(
    (_, index) =>
      index > 0 &&
      invocationVerb({ ...invocation, argv: argv.slice(0, index + 1) }) !==
        undefined
  );
  return invocationVerb({
    ...invocation,
    argv: argv.filter((_, index) => index !== verbAt),
  });
}

export function isGenTypes(invocation: SupabaseInvocation): boolean {
  return (
    invocationVerb(invocation) === 'gen' && subcommand(invocation) === 'types'
  );
}

/** Direct `supabase gen types` invocations, the distinct database sources they named, the runs whose tool call errored and the runs that succeeded. */
export function countGenTypesRuns(
  invocations: readonly SupabaseInvocation[],
  toolCalls: readonly ToolCallRecord[]
): GenTypesRuns {
  const runs = invocations.filter(isGenTypes);
  const records = commandToolCalls(toolCalls);
  const entries = extractCommandEntries(toolCalls);
  return {
    runs: runs.length,
    sources: [...new Set(runs.map(genTypesSource))],
    failed: runs.flatMap(({ commandIndex }) => {
      const call = records[commandIndex];
      return call?.error === undefined || genTypesRunSucceeded(call)
        ? []
        : [
            {
              command: entries[commandIndex]?.command ?? '',
              silent: call.error === '',
            },
          ];
    }),
    succeeded: runs.flatMap(({ commandIndex }) => {
      const call = records[commandIndex];
      return genTypesRunSucceeded(call)
        ? [
            {
              command: entries[commandIndex]?.command ?? '',
              laterCommandFailed: call?.error !== undefined,
            },
          ]
        : [];
    }),
  };
}

/** Commands of the tool calls recorded with an empty error, which the transcript shows as no output, leaving out the gen types runs `countGenTypesRuns` already lists. */
export function listSilentFailures(
  invocations: readonly SupabaseInvocation[],
  toolCalls: readonly ToolCallRecord[]
): string[] {
  const genTypesCalls = new Set(
    invocations.filter(isGenTypes).map(({ commandIndex }) => commandIndex)
  );
  const entries = extractCommandEntries(toolCalls);
  return commandToolCalls(toolCalls).flatMap((call, index) =>
    call.error === '' && !genTypesCalls.has(index)
      ? [entries[index]?.command ?? '']
      : []
  );
}

export function checkTypesRegenerated({
  runs,
  failed,
  succeeded,
}: GenTypesRuns): CheckResult {
  const name = 'types were regenerated with supabase gen types';
  const last = succeeded.at(-1);
  if (last !== undefined) {
    return {
      name,
      passed: true,
      notes: last.laterCommandFailed
        ? `\`${last.command}\` printed the generated types after connecting, with no CLI error in its output; a later command in the same tool call exited non-zero`
        : `\`${last.command}\` exited zero with no CLI error in its output`,
    };
  }
  if (runs === 0) {
    return {
      name,
      passed: false,
      notes:
        'no direct `supabase gen types` run (runs through package scripts are not counted)',
    };
  }
  const printedError = runs - failed.length;
  return {
    name,
    passed: false,
    notes: `no gen types run succeeded: ${[
      ...failed.map(({ command }) => `tool call errored: \`${command}\``),
      ...(printedError > 0
        ? [`${printedError} printed a CLI error or recorded no output`]
        : []),
    ].join('; ')}`,
  };
}

export type StackLifecycle = {
  lastCommand: string | null;
  stoppedByAgent: boolean;
};

const STACK_START_COMMANDS = new Set([
  'start',
  'stack start',
  'stack restart',
  'db start',
]);
const STACK_STOP_COMMANDS = new Set(['stop', 'stack stop', 'stack destroy']);

function lifecycleCommand(invocation: SupabaseInvocation): string | undefined {
  const verb = invocationVerb(invocation);
  if (verb === undefined) return undefined;
  const command = verb === 'db' ? `db ${subcommand(invocation)}` : verb;
  return STACK_START_COMMANDS.has(command) || STACK_STOP_COMMANDS.has(command)
    ? command
    : undefined;
}

/** The last stack start or stop invocation the agent ran, flags included, and whether it left the stack stopped. */
export function readStackLifecycle(
  invocations: readonly SupabaseInvocation[]
): StackLifecycle {
  const last = invocations
    .flatMap((invocation) => {
      const command = lifecycleCommand(invocation);
      return command === undefined ? [] : [{ command, argv: invocation.argv }];
    })
    .at(-1);
  return last === undefined
    ? { lastCommand: null, stoppedByAgent: false }
    : {
        lastCommand: last.argv.join(' '),
        stoppedByAgent: STACK_STOP_COMMANDS.has(last.command),
      };
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
    lifecycle: StackLifecycle;
    analysis: ProjectAnalysis;
    cli: CliFacts;
    migrationEvidence: MigrationEvidenceSource;
  }
): Promise<CheckResult> {
  const { commands, genTypes, stack, lifecycle, analysis, migrationEvidence } =
    facts;
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
    genTypesFailedRuns: await safely(() => genTypes.failed.length),
    genTypesSucceededRuns: await safely(() => genTypes.succeeded.length),
    genTypesSources: await safely(() => genTypes.sources),
    stackStoppedByAgent: await safely(() => lifecycle.stoppedByAgent),
    migrationEvidence,
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
