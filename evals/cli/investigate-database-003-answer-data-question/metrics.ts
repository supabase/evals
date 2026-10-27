import type {
  CheckResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import {
  listCliOverrides,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { readCliVersions, safely } from '../lib/metrics.js';
import { type StackProbe, urlPort } from '../lib/stack.js';
import {
  type DbQueryRun,
  isDbQueryInvocation,
  replyStatesCount,
} from './answer.js';
import { countPsqlCommands } from './fallback.js';

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;

export type CliFacts = {
  versions: Awaited<ReturnType<typeof readCliVersions>> | null;
  cliOverride: string[] | null;
};

export async function readCliFacts(
  ctx: ExecContext,
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

function stackMetrics(stack: StackProbe) {
  return stack.ok
    ? {
        backend: stack.backend,
        runtime: stack.runtime,
        relocatedHome: stack.relocatedHome ?? null,
        dbPort: urlPort(stack.dbUrl) ?? null,
      }
    : { backend: 'none', runtime: 'none', relocatedHome: null, dbPort: null };
}

const FLAG_RE = /^--?[A-Za-z][\w-]*(?:=|$)/;

function dbQueryFlags(invocations: readonly SupabaseInvocation[]): string[] {
  return [
    ...new Set(
      invocations
        .filter(isDbQueryInvocation)
        .flatMap(({ argv }) => argv.slice(1))
        .filter((token) => FLAG_RE.test(token))
        .map((token) => token.split('=')[0])
    ),
  ].sort();
}

export async function checkMetrics(
  marker: LocalStackEnvironmentMarker | undefined,
  facts: {
    commands: readonly string[];
    invocations: readonly SupabaseInvocation[];
    stack: StackProbe;
    cli: CliFacts;
    dbQueryRuns: readonly DbQueryRun[];
    reply: string | undefined;
  }
): Promise<CheckResult> {
  const { commands, invocations, stack, cli, dbQueryRuns, reply } = facts;
  const { versions, cliOverride } = cli;

  const metrics = {
    cliVersion: versions?.cliVersion ?? null,
    ...(versions?.cliVersionAfterRun === undefined
      ? {}
      : { cliVersionAfterRun: versions.cliVersionAfterRun }),
    cliOverride,
    channel: marker?.channel ?? 'pinned',
    ...stackMetrics(stack),
    commands: await safely(() => commands.length),
    supabaseInvocations: await safely(() => invocations.length),
    dbQueryRuns: await safely(() => dbQueryRuns.length),
    dbQueryErrored: await safely(
      () => dbQueryRuns.filter(({ errored }) => errored).length
    ),
    dbQueryFlags: await safely(() => dbQueryFlags(invocations)),
    psqlCommands: await safely(() => countPsqlCommands(commands)),
    answerInReply: await safely(
      () => reply !== undefined && replyStatesCount(reply)
    ),
  };

  return { name: 'metrics', passed: true, notes: JSON.stringify(metrics) };
}
