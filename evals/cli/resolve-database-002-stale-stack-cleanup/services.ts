import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import {
  invocationTargetUnresolved,
  invocationTargets,
  isStartInvocation,
  type InvocationEnv,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { findProjectDirs } from '../lib/projects.js';
import {
  candidateHomes,
  probeStackReady,
  resolveStackWithAgentHomes,
  type StackProbe,
  type StackTarget,
} from '../lib/stack.js';
import { readStackList, type StackListProbe } from '../lib/stack-list.js';

export const SERVICES = [
  'checkout-service',
  'payments-api',
  'legacy-import',
] as const;
export type Service = (typeof SERVICES)[number];
export type ServiceDirs = {
  found: Partial<Record<Service, string>>;
  problems: Partial<Record<Service, string>>;
  all: string[];
  /** Services whose only trace is a named stack started from the sandbox root. */
  namedAtRoot?: Service[];
  /** Services whose directory came from `stack list` rather than a `config.toml`. */
  fromStackList?: Service[];
};

const SURVIVING: readonly Service[] = ['checkout-service', 'payments-api'];

type ListedStack = { root: string; reachable: boolean };

function listedStacks(list: StackListProbe, service: Service): ListedStack[] {
  if (!list.ok) return [];
  return list.stacks.flatMap((entry) => {
    const { name, project_root, owner } = (entry ?? {}) as Record<
      string,
      unknown
    >;
    return name === service && typeof project_root === 'string' && project_root
      ? [
          {
            root: project_root.replace(/(?<=.)\/+$/, ''),
            reachable: owner === 'reachable',
          },
        ]
      : [];
  });
}

async function readSandboxRoot(
  ctx: Pick<LocalStackEvalContext, 'exec'>
): Promise<string | undefined> {
  try {
    const root = (await ctx.exec('pwd -P')).stdout.trim();
    return root === '' ? undefined : root;
  } catch {
    return undefined;
  }
}

function stackListReader(ctx: Pick<LocalStackEvalContext, 'exec'>) {
  const lists = new Map<string, Promise<StackListProbe>>();
  return (home?: InvocationEnv) => {
    const key = JSON.stringify(home ?? null);
    const cached = lists.get(key);
    if (cached) return cached;
    const read = readStackList(ctx, home);
    lists.set(key, read);
    return read;
  };
}

/** Distinct project roots of the `stack list` entries named `service` (reachable ones when any), under the default home and each relocated home the agent started it with. */
async function listedRoots(
  listUnder: ReturnType<typeof stackListReader>,
  service: Service,
  invocations: readonly SupabaseInvocation[]
): Promise<string[]> {
  const homes = [
    undefined,
    ...candidateHomes(
      invocations,
      { kind: 'named', stackName: service },
      SERVICES
    ),
  ];
  const entries = (
    await Promise.all(
      homes.map(async (home) => listedStacks(await listUnder(home), service))
    )
  ).flat();
  const preferred = entries.some((entry) => entry.reachable)
    ? entries.filter((entry) => entry.reachable)
    : entries;
  return [...new Set(preferred.map((entry) => entry.root))];
}

/**
 * Finds each service's project directory by `supabase/config.toml`, then, for
 * services without one, from the CLI's own `stack list` (default home and
 * every relocated home the agent started the service under), which also
 * covers stacks created without `supabase init`.
 */
export async function findServiceDirs(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  invocations: readonly SupabaseInvocation[] = []
): Promise<ServiceDirs> {
  const dirs = await findProjectDirs(ctx, SERVICES);
  const unresolved = SERVICES.filter(
    (service) => dirs.found[service] === undefined
  );
  if (unresolved.length === 0) return dirs;

  const listUnder = stackListReader(ctx);
  let sandboxRoot: Promise<string | undefined> | undefined;
  const namedAtRoot: Service[] = [];
  const fromStackList: Service[] = [];
  const found = { ...dirs.found };
  const problems = { ...dirs.problems };

  for (const service of unresolved) {
    const roots = await listedRoots(listUnder, service, invocations);
    if (roots.length > 1) {
      problems[service] = `ambiguous (stack list: ${roots.join(', ')})`;
    } else if (roots.length === 1) {
      sandboxRoot ??= readSandboxRoot(ctx);
      if (roots[0] === (await sandboxRoot)) {
        namedAtRoot.push(service);
      } else {
        found[service] = roots[0];
        fromStackList.push(service);
      }
      delete problems[service];
    }
  }
  return { ...dirs, found, problems, namedAtRoot, fromStackList };
}

// legacy-import's directory may legitimately be gone — deleting it is a fair
// reading of "we killed that project" — so only the survivors are required.
export function checkServiceProjectsExist(dirs: ServiceDirs): CheckResult {
  const name = 'checkout-service and payments-api projects exist';
  const atRoot = (service: Service) =>
    dirs.namedAtRoot?.includes(service) === true;
  const describe = (service: Service) => {
    const dir = dirs.found[service];
    if (dir !== undefined) {
      const listed = dirs.fromStackList?.includes(service) === true;
      return `${service}: ${dir}${listed ? ' (from stack list)' : ''}`;
    }
    return `${service}: ${atRoot(service) ? 'named stack at sandbox root' : dirs.problems[service]}`;
  };
  return {
    name,
    passed: SURVIVING.every(
      (service) => dirs.found[service] !== undefined || atRoot(service)
    ),
    notes: SERVICES.map(describe).join('; '),
  };
}

export function serviceStackTarget(
  service: Service,
  dir: string | undefined
): StackTarget {
  return dir === undefined
    ? { kind: 'named', stackName: service }
    : { kind: 'project', dir, stackName: service };
}

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;

// The resolution cascades overlap (a renamed-stack lookup retries the managed
// and legacy probes the service-named lookup already ran), and every probe is
// a read, so each distinct command runs once per scoring pass.
function memoizeExec(ctx: ExecContext): ExecContext {
  const results = new Map<string, ReturnType<ExecContext['exec']>>();
  return {
    exec: (command, options) => {
      const cached = results.get(command);
      if (cached) return cached;
      const result = ctx.exec(command, options);
      results.set(command, result);
      return result;
    },
  };
}

function appendNewNotes(prior: string, next: string): string {
  const seen = new Set(prior.split('; '));
  const added = next.split('; ').filter((note) => !seen.has(note));
  return [prior, ...added].join('; ');
}

export async function resolveServiceStacks(
  scoringCtx: ExecContext,
  dirs: ServiceDirs,
  invocations: readonly SupabaseInvocation[] = []
): Promise<Record<Service, StackProbe>> {
  const ctx = memoizeExec(scoringCtx);
  const stacks = {} as Record<Service, StackProbe>;
  const listUnder = stackListReader(ctx);
  for (const service of SERVICES) {
    const dir = dirs.found[service];
    const byName = await resolveStackWithAgentHomes(
      ctx,
      serviceStackTarget(service, dir),
      invocations,
      SERVICES
    );
    const renamed =
      byName.ok || dir === undefined
        ? byName
        : await resolveRenamedStack(ctx, dir, byName.notes, invocations);
    stacks[service] =
      renamed.ok || dir === undefined
        ? renamed
        : await resolveListedStack(
            ctx,
            listUnder,
            service,
            dir,
            renamed.notes,
            invocations
          );
  }
  return stacks;
}

// The agent may have broken the service's config.toml or rooted its stack in
// another directory, so a lone `stack list` entry named for it locates the stack.
async function resolveListedStack(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  listUnder: ReturnType<typeof stackListReader>,
  service: Service,
  dir: string,
  priorNotes: string,
  invocations: readonly SupabaseInvocation[]
): Promise<StackProbe> {
  const roots = await listedRoots(listUnder, service, invocations);
  if (roots.length !== 1 || roots[0] === dir) {
    return { ok: false, notes: priorNotes };
  }
  const listed = await resolveStackWithAgentHomes(
    ctx,
    serviceStackTarget(service, roots[0]),
    invocations,
    SERVICES
  );
  return listed.ok
    ? listed
    : {
        ok: false,
        notes: `${priorNotes}; stack list root ${roots[0]}: ${listed.notes}`,
      };
}

// Agents may recreate a service's stack under a different name, so when the
// service-named stack is missing, fall back to any named stack for its dir.
async function resolveRenamedStack(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  dir: string,
  namedNotes: string,
  invocations: readonly SupabaseInvocation[]
): Promise<StackProbe> {
  const discovered = await resolveStackWithAgentHomes(
    ctx,
    { kind: 'project', dir },
    invocations,
    SERVICES
  );
  return discovered.ok
    ? discovered
    : { ok: false, notes: appendNewNotes(namedNotes, discovered.notes) };
}

type StartRecord = SupabaseInvocation & { failed?: boolean };

function isLater(a: SupabaseInvocation, b: SupabaseInvocation): boolean {
  return a.at !== undefined && b.at !== undefined ? a.at >= b.at : true;
}

/** Surviving services whose latest start that didn't fail ran through a `cliOverride` runner, mapped to that runner. */
export function findSwappedServices(
  invocations: readonly StartRecord[],
  cliOverride: readonly string[]
): Partial<Record<Service, string>> {
  const swapped: Partial<Record<Service, string>> = {};
  for (const service of SURVIVING) {
    const starts = invocations.filter(
      (inv) =>
        !inv.failed &&
        isStartInvocation(inv) &&
        (invocationTargetUnresolved(inv) ||
          invocationTargets(inv, service, SERVICES))
    );
    if (starts.length === 0) continue;
    const { runner } = starts.reduce((latest, inv) =>
      isLater(inv, latest) ? inv : latest
    );
    if (runner && cliOverride.includes(runner)) swapped[service] = runner;
  }
  return swapped;
}

export function describeSwap(service: Service, runners: string): string {
  return `${service}: started with ${runners}, not the installed CLI`;
}

export async function checkStackRunning(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  service: Service,
  stack: StackProbe,
  cliOverride: readonly string[] = [],
  invocations: readonly StartRecord[] = []
): Promise<CheckResult> {
  const name = `${service} stack is running`;
  const { ready, notes } = await probeStackReady(ctx, stack);
  const swapped = findSwappedServices(invocations, cliOverride)[service];
  const state = stack.ok ? `resolved, ${notes}` : `does not resolve (${notes})`;
  const relocated =
    stack.ok && stack.relocatedHome !== undefined
      ? `, relocated home: ${stack.relocatedHome}`
      : '';
  return {
    name,
    passed: ready && swapped === undefined,
    notes: `state: ${state}${relocated}${swapped === undefined ? '' : `; ${describeSwap(service, swapped)}`}`,
  };
}
