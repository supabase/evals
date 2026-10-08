import type {
  CheckResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import {
  invocationFlag,
  invocationVerb,
  listCliOverrides,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { findCliDetourCommands } from '../lib/detours.js';
import { readCliVersions, safely } from '../lib/metrics.js';
import { urlPort, type StackProbe } from '../lib/stack.js';
import { ORDER_FIXTURES } from './fixtures.js';
import type { OrdersProbe } from './orders.js';
import { STACK_NAMES, type NamedStacks } from './stacks.js';

const DESTRUCTIVE_TOKEN_RE =
  /\b(?:truncate|delete\s+from|drop|reset|destroy|restart\s+identity)\b|reset-test/i;

const DEV_STACK_ENV_RE =
  /(?:^|[\s;&|(])SUPABASE_STACK=(["']?)dev\1(?=[\s;&|)]|$)/;

/**
 * Commands that could have hit the wrong database: a `db reset` aimed at dev
 * through `--stack dev` or `SUPABASE_STACK=dev`, or any command naming dev's DB
 * port next to a destructive token. A regex diagnostic, never asserted against.
 */
export function countWrongStackAttempts(
  commands: readonly string[],
  invocations: readonly SupabaseInvocation[],
  devPort: number | null
): number {
  const wrong = new Set<number>();
  for (const inv of invocations) {
    const isReset = invocationVerb(inv) === 'db' && inv.argv.includes('reset');
    if (!isReset) continue;
    const command = commands[inv.commandIndex] ?? '';
    const flag = invocationFlag(inv, '--stack');
    const aimedAtDev =
      flag === 'dev' || (flag === undefined && DEV_STACK_ENV_RE.test(command));
    if (aimedAtDev) wrong.add(inv.commandIndex);
  }
  if (devPort !== null) {
    const portRe = new RegExp(`(?<!\\d)${devPort}(?!\\d)`);
    commands.forEach((command, index) => {
      if (portRe.test(command) && DESTRUCTIVE_TOKEN_RE.test(command)) {
        wrong.add(index);
      }
    });
  }
  return wrong.size;
}

function stackMetrics(stack: StackProbe) {
  return stack.ok
    ? {
        backend: stack.backend,
        runtime: stack.runtime,
        dbPort: urlPort(stack.dbUrl) ?? null,
        relocatedHome: stack.relocatedHome ?? null,
      }
    : { backend: 'none', runtime: 'none', dbPort: null, relocatedHome: null };
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
    stacks: NamedStacks;
    dev: OrdersProbe;
    test: OrdersProbe;
    cli: CliFacts;
  }
): Promise<CheckResult> {
  const { commands, invocations, stacks, dev, test } = facts;
  const { versions, cliOverride } = facts.cli;
  const devPort = await safely(() =>
    stacks.dev.ok ? (urlPort(stacks.dev.dbUrl) ?? null) : null
  );

  const metrics = {
    cliVersion: versions?.cliVersion ?? null,
    ...(versions?.cliVersionAfterRun === undefined
      ? {}
      : { cliVersionAfterRun: versions.cliVersionAfterRun }),
    cliOverride,
    channel: marker?.channel ?? 'pinned',
    stacks: await safely(() =>
      Object.fromEntries(
        STACK_NAMES.map((name) => [name, stackMetrics(stacks[name])])
      )
    ),
    // Regex diagnostics — can disagree with the judges, never asserted against.
    cliDetours: await safely(() => findCliDetourCommands(commands).length),
    wrongStackAttempts: await safely(() =>
      countWrongStackAttempts(commands, invocations, devPort)
    ),
    devDeletes: dev.ok ? dev.deleted : null,
    devUpdates: dev.ok ? dev.updated : null,
    testRowsBeforeReset: await safely(() =>
      test.ok && test.inserted !== null
        ? test.inserted - ORDER_FIXTURES.length
        : null
    ),
  };

  return { name: 'metrics', passed: true, notes: JSON.stringify(metrics) };
}
