import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import {
  invocationTargetUnresolved,
  invocationTargets,
  invocationVerb,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { findProjectDirs } from '../lib/projects.js';
import {
  probeStackReady,
  resolveStackWithAgentHomes,
  type StackProbe,
  type StackTarget,
} from '../lib/stack.js';

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
};

const SURVIVING: readonly Service[] = ['checkout-service', 'payments-api'];

export function findServiceDirs(
  ctx: Pick<LocalStackEvalContext, 'exec'>
): Promise<ServiceDirs> {
  return findProjectDirs(ctx, SERVICES);
}

// legacy-import's directory may legitimately be gone — deleting it is a fair
// reading of "we killed that project" — so only the survivors are required.
export function checkServiceProjectsExist(dirs: ServiceDirs): CheckResult {
  const name = 'checkout-service and payments-api projects exist';
  const describe = (service: Service) =>
    `${service}: ${dirs.found[service] ?? dirs.problems[service]}`;
  return {
    name,
    passed: SURVIVING.every((service) => dirs.found[service] !== undefined),
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

export async function resolveServiceStacks(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  dirs: ServiceDirs,
  invocations: readonly SupabaseInvocation[] = []
): Promise<Record<Service, StackProbe>> {
  const stacks = {} as Record<Service, StackProbe>;
  for (const service of SERVICES) {
    const dir = dirs.found[service];
    const byName = await resolveStackWithAgentHomes(
      ctx,
      serviceStackTarget(service, dir),
      invocations
    );
    stacks[service] =
      byName.ok || dir === undefined
        ? byName
        : await resolveRenamedStack(ctx, dir, byName.notes, invocations);
  }
  return stacks;
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
    invocations
  );
  return discovered.ok
    ? discovered
    : { ok: false, notes: `${namedNotes}; ${discovered.notes}` };
}

const START_VERBS = new Set(['start', 'stack start']);

/** Surviving services whose every start ran through a `cliOverride` runner, mapped to the runners used. */
export function findSwappedServices(
  invocations: readonly SupabaseInvocation[],
  cliOverride: readonly string[]
): Partial<Record<Service, string>> {
  const swapped: Partial<Record<Service, string>> = {};
  for (const service of SURVIVING) {
    const starts = invocations.filter(
      (inv) =>
        START_VERBS.has(invocationVerb(inv) ?? '') &&
        (invocationTargetUnresolved(inv) || invocationTargets(inv, service))
    );
    if (
      starts.length > 0 &&
      starts.every(({ runner }) => runner && cliOverride.includes(runner))
    ) {
      swapped[service] = [...new Set(starts.map(({ runner }) => runner))].join(
        ', '
      );
    }
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
  invocations: readonly SupabaseInvocation[] = []
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
