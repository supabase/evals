import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { findProjectDirs } from '../lib/projects.js';
import {
  probeStackReady,
  resolveStack,
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
  dirs: ServiceDirs
): Promise<Record<Service, StackProbe>> {
  const stacks = {} as Record<Service, StackProbe>;
  for (const service of SERVICES) {
    stacks[service] = await resolveStack(
      ctx,
      serviceStackTarget(service, dirs.found[service])
    );
  }
  return stacks;
}

export async function checkStackRunning(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  service: Service,
  stack: StackProbe
): Promise<CheckResult> {
  const name = `${service} stack is running`;
  const { ready, notes } = await probeStackReady(ctx, stack);
  return { name, passed: ready, notes };
}
