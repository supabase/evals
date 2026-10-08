import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import type {
  InvocationEnv,
  SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { shellQuote, truncate } from '../lib/shell.js';
import {
  candidateHomes,
  maskUrlCredentials,
  probeStackReady,
  resolveStackWithAgentHomes,
  type StackProbe,
} from '../lib/stack.js';
import { readStackList, type StackListProbe } from '../lib/stack-list.js';

export const STACK_NAMES = ['dev', 'test'] as const;
export type StackName = (typeof STACK_NAMES)[number];
export type NamedStacks = Record<StackName, StackProbe>;

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;
type HomeStackList = { home?: InvocationEnv; list: StackListProbe };

async function realPath(ctx: ExecContext, path: string): Promise<string> {
  try {
    const result = await ctx.exec(`realpath -m -- ${shellQuote(path)}`);
    const resolved = result.stdout.trim();
    return result.ok && resolved ? resolved : path;
  } catch {
    return path;
  }
}

/** `stack list` under the default home and each relocated home the agent started either stack under. */
async function readStackLists(
  ctx: ExecContext,
  workspace: string,
  invocations: readonly SupabaseInvocation[]
): Promise<HomeStackList[]> {
  const homes = new Map<string, InvocationEnv>();
  for (const stackName of STACK_NAMES) {
    for (const home of candidateHomes(
      invocations,
      { kind: 'project', dir: workspace, stackName },
      STACK_NAMES
    )) {
      homes.set(JSON.stringify(home), home);
    }
  }
  return [
    { list: await readStackList(ctx) },
    ...(await Promise.all(
      [...homes.values()].map(async (home) => ({
        home,
        list: await readStackList(ctx, home),
      }))
    )),
  ];
}

type ListedEntry = { name?: unknown; project_root?: unknown };

async function findListedStack(
  ctx: ExecContext,
  lists: readonly HomeStackList[],
  stackName: StackName,
  workspace: string
): Promise<{ found: true } | { found: false; notes: string }> {
  const listed: string[] = [];
  const failures: string[] = [];
  for (const { list } of lists) {
    if (!list.ok) {
      failures.push(list.notes);
      continue;
    }
    for (const entry of list.stacks as ListedEntry[]) {
      if (typeof entry?.name !== 'string') continue;
      const root =
        typeof entry.project_root === 'string'
          ? await realPath(ctx, entry.project_root)
          : undefined;
      if (entry.name === stackName && root === workspace)
        return { found: true };
      listed.push(`${entry.name}@${root ?? 'unknown root'}`);
    }
  }
  const summary =
    listed.length > 0
      ? `stack list has ${truncate(listed.join(', '), 300)}`
      : failures.length > 0
        ? `stack list unavailable: ${truncate(failures.join('; '), 300)}`
        : 'stack list is empty';
  return {
    found: false,
    notes: `no stack named '${stackName}' registered for ${workspace}; ${summary}`,
  };
}

async function resolveNamedStack(
  ctx: ExecContext,
  stackName: StackName,
  workspace: string,
  invocations: readonly SupabaseInvocation[],
  lists: readonly HomeStackList[]
): Promise<StackProbe> {
  const listing = await findListedStack(
    ctx,
    lists,
    stackName,
    await realPath(ctx, workspace)
  );
  if (!listing.found) return { ok: false, notes: listing.notes };
  const probe = await resolveStackWithAgentHomes(
    ctx,
    { kind: 'project', dir: workspace, stackName },
    invocations,
    STACK_NAMES
  );
  if (!probe.ok) {
    return {
      ok: false,
      notes: `'${stackName}' is listed but did not resolve: ${probe.notes}`,
    };
  }
  if (probe.backend !== 'managed-named') {
    return {
      ok: false,
      notes: `'${stackName}' is listed but resolved to the ${probe.backend} stack, not the named one`,
    };
  }
  return probe;
}

/** Resolves `dev` and `test` as named stacks registered for `workspace`; the default stack never stands in for either. */
export async function resolveNamedStacks(
  ctx: ExecContext,
  workspace: string,
  invocations: readonly SupabaseInvocation[]
): Promise<NamedStacks> {
  const lists = await readStackLists(ctx, workspace, invocations);
  const dev = await resolveNamedStack(
    ctx,
    'dev',
    workspace,
    invocations,
    lists
  );
  const test = await resolveNamedStack(
    ctx,
    'test',
    workspace,
    invocations,
    lists
  );
  return { dev, test };
}

export async function checkStackRunning(
  ctx: ExecContext,
  stackName: StackName,
  stack: StackProbe
): Promise<CheckResult> {
  const { ready, notes } = await probeStackReady(ctx, stack);
  return {
    name: `${stackName} stack is running for this project`,
    passed: ready,
    notes,
  };
}

function endpoint(dbUrl: string): string | undefined {
  try {
    const { hostname, port } = new URL(dbUrl);
    return port ? `${hostname}:${port}` : undefined;
  } catch {
    return undefined;
  }
}

export function checkSeparateDatabases(stacks: NamedStacks): CheckResult {
  const name = 'dev and test are separate databases';
  const { dev, test } = stacks;
  if (!dev.ok || !test.ok) {
    return {
      name,
      passed: false,
      notes: STACK_NAMES.map((stackName) => {
        const stack = stacks[stackName];
        return `${stackName}: ${stack.ok ? 'resolved' : stack.notes}`;
      }).join('; '),
    };
  }
  const devEndpoint = endpoint(dev.dbUrl);
  const testEndpoint = endpoint(test.dbUrl);
  if (devEndpoint === undefined || testEndpoint === undefined) {
    return {
      name,
      passed: false,
      notes: `could not read host:port from the DB URLs (dev: ${maskUrlCredentials(dev.dbUrl)}, test: ${maskUrlCredentials(test.dbUrl)})`,
    };
  }
  const passed = devEndpoint !== testEndpoint;
  return {
    name,
    passed,
    notes: passed
      ? `dev ${devEndpoint}, test ${testEndpoint}`
      : `dev and test both resolved to ${devEndpoint}, so they are one database`,
  };
}
