import type {
  CheckResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { countRawDockerSocketProbes } from '../lib/detours.js';
import {
  countClearedDockerHost,
  readCliVersion,
  safely,
} from '../lib/metrics.js';
import {
  readPostmasterStartMs,
  urlPort,
  type StackProbe,
} from '../lib/stack.js';
import type { StackListProbe } from '../lib/stack-list.js';
import { SERVICES, type Service } from './services.js';

const SURVIVING = new Set<Service>(['checkout-service', 'payments-api']);

async function serviceMetrics(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  service: Service,
  stack: StackProbe
) {
  if (!stack.ok) {
    return {
      backend: 'none',
      runtime: 'none',
      dbPort: null,
      apiPort: null,
      postmasterStartMs: null,
    };
  }
  return {
    backend: stack.backend,
    runtime: stack.runtime,
    dbPort: urlPort(stack.dbUrl) ?? null,
    apiPort: stack.apiUrl ? (urlPort(stack.apiUrl) ?? null) : null,
    postmasterStartMs: SURVIVING.has(service)
      ? await safely(() => readPostmasterStartMs(ctx, stack.dbUrl))
      : null,
  };
}

export async function checkMetrics(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  marker: LocalStackEnvironmentMarker | undefined,
  commands: readonly string[],
  cliDetourCommands: readonly string[],
  stackList: StackListProbe,
  stacks: Record<Service, StackProbe>
): Promise<CheckResult> {
  const services = {} as Record<
    Service,
    Awaited<ReturnType<typeof serviceMetrics>>
  >;
  for (const service of SERVICES) {
    services[service] = await serviceMetrics(ctx, service, stacks[service]);
  }
  const checkoutMs = services['checkout-service'].postmasterStartMs;
  const paymentsMs = services['payments-api'].postmasterStartMs;

  const metrics = {
    cliVersion: await readCliVersion(ctx),
    channel: marker?.channel ?? 'pinned',
    services,
    // Unverified whether native `stack restart` restarts Postgres, so this is
    // reported rather than asserted by `checkout-service was restarted`.
    checkoutPostmasterNewerThanPayments:
      checkoutMs !== null && paymentsMs !== null
        ? checkoutMs > paymentsMs
        : null,
    stackListAvailable: stackList.ok,
    stackCount: stackList.ok ? stackList.stacks.length : null,
    // Regex-based diagnostic — can disagree with the detour judge.
    cliDetours: cliDetourCommands.length,
    clearedDockerHost: await safely(() => countClearedDockerHost(commands)),
    rawDockerSocketProbes: await safely(() =>
      countRawDockerSocketProbes(commands)
    ),
  };

  return { name: 'metrics', passed: true, notes: JSON.stringify(metrics) };
}
