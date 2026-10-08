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
  resolveStack,
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

const DISCOVERY_ROOTS = ['/tmp'];
const DISCOVERY_MAX_DEPTH = 8;
const STATE_FILE_RE = /^(\/.+)\/stacks\/[^/]+\/state\.json$/;

function homeRoot(home: InvocationEnv): string | undefined {
  if (home.SUPABASE_HOME !== undefined) return home.SUPABASE_HOME;
  return home.HOME === undefined ? undefined : `${home.HOME}/.supabase`;
}

/** CLI homes holding managed-stack state under the workspace or `/tmp`, found by their `stacks/<id>/state.json` files. */
async function discoverHomeRoots(
  ctx: ExecContext,
  workspace: string
): Promise<string[]> {
  try {
    const roots = [workspace, ...DISCOVERY_ROOTS]
      .map((root) => shellQuote(root))
      .join(' ');
    const { stdout } = await ctx.exec(
      `find ${roots} -maxdepth ${DISCOVERY_MAX_DEPTH} -type d \\( -name node_modules -o -name .git -o -path '*/stacks/*/*' \\) -prune -o -type f -path '*/stacks/*/state.json' -print 2>/dev/null`
    );
    return [
      ...new Set(
        stdout
          .split('\n')
          .flatMap((line) => STATE_FILE_RE.exec(line.trim())?.[1] ?? [])
      ),
    ];
  } catch {
    return [];
  }
}

async function defaultHomeRoot(ctx: ExecContext): Promise<string | undefined> {
  try {
    const { ok, stdout } = await ctx.exec(
      'printf %s "${SUPABASE_HOME:-$HOME/.supabase}"'
    );
    return ok && stdout.trim() ? stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `stack list` under the default home, each relocated home the agent started
 * either stack under, and each other home found on disk (an agent may relocate
 * the home inside a script, where no invocation shows it).
 */
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
      const root = homeRoot(home);
      if (root !== undefined) homes.set(root, home);
    }
  }
  const known = new Set([...homes.keys(), await defaultHomeRoot(ctx)]);
  for (const root of await discoverHomeRoots(ctx, workspace)) {
    if (!known.has(root)) homes.set(root, { SUPABASE_HOME: root });
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

type ListedStack = {
  name: string;
  root?: string;
  reachable: boolean;
  home?: InvocationEnv;
};

async function listedStacks(
  ctx: ExecContext,
  lists: readonly HomeStackList[]
): Promise<{ stacks: ListedStack[]; failures: string[] }> {
  const stacks: ListedStack[] = [];
  const failures: string[] = [];
  for (const { home, list } of lists) {
    if (!list.ok) {
      failures.push(list.notes);
      continue;
    }
    for (const entry of list.stacks as Array<{
      name?: unknown;
      project_root?: unknown;
      owner?: unknown;
    } | null>) {
      if (typeof entry?.name !== 'string') continue;
      stacks.push({
        name: entry.name,
        root:
          typeof entry.project_root === 'string'
            ? await realPath(ctx, entry.project_root)
            : undefined,
        reachable: entry.owner === 'reachable',
        home,
      });
    }
  }
  return { stacks, failures };
}

async function resolveNamedStack(
  ctx: ExecContext,
  stackName: StackName,
  workspace: string,
  listing: { stacks: readonly ListedStack[]; failures: readonly string[] },
  realWorkspace: string
): Promise<StackProbe> {
  const candidates = listing.stacks
    .filter(({ name, root }) => name === stackName && root === realWorkspace)
    .sort((a, b) => Number(b.reachable) - Number(a.reachable));
  if (candidates.length === 0) {
    const listed = listing.stacks.map(
      ({ name, root }) => `${name}@${root ?? 'unknown root'}`
    );
    const summary =
      listed.length > 0
        ? `stack list has ${truncate(listed.join(', '), 300)}`
        : listing.failures.length > 0
          ? `stack list unavailable: ${truncate(listing.failures.join('; '), 300)}`
          : 'stack list is empty';
    return {
      ok: false,
      notes: `no stack named '${stackName}' registered for ${realWorkspace}; ${summary}`,
    };
  }
  const notes: string[] = [];
  for (const { home } of candidates) {
    const probe = await resolveStack(
      ctx,
      { kind: 'project', dir: workspace, stackName },
      { home }
    );
    if (!probe.ok) {
      notes.push(`did not resolve: ${probe.notes}`);
    } else if (probe.backend !== 'managed-named') {
      notes.push(`resolved to the ${probe.backend} stack, not the named one`);
    } else {
      const relocatedHome = home && homeRoot(home);
      return relocatedHome === undefined ? probe : { ...probe, relocatedHome };
    }
  }
  return {
    ok: false,
    notes: `'${stackName}' is listed but ${notes.join('; ')}`,
  };
}

/** Resolves `dev` and `test` as named stacks registered for `workspace`; the default stack never stands in for either. */
export async function resolveNamedStacks(
  ctx: ExecContext,
  workspace: string,
  invocations: readonly SupabaseInvocation[]
): Promise<NamedStacks> {
  const listing = await listedStacks(
    ctx,
    await readStackLists(ctx, workspace, invocations)
  );
  const realWorkspace = await realPath(ctx, workspace);
  const dev = await resolveNamedStack(
    ctx,
    'dev',
    workspace,
    listing,
    realWorkspace
  );
  const test = await resolveNamedStack(
    ctx,
    'test',
    workspace,
    listing,
    realWorkspace
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
