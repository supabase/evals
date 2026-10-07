import type {
  CheckResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import {
  isStartInvocation,
  listUnverifiedRunners,
} from '../lib/cli-invocations.js';
import { countRawDockerSocketProbes } from '../lib/detours.js';
import {
  countClearedDockerHost,
  readCliVersion,
  safely,
} from '../lib/metrics.js';
import { urlPort, type StackProbe } from '../lib/stack.js';
import type { StackListProbe } from '../lib/stack-list.js';
import {
  decideCheckoutRestart,
  decidePaymentsUntouched,
  findLegacyLifecycle,
  findSetup,
  lifecycleEvents,
  type FleetInvocation,
  type PostmasterStarts,
} from './fleet.js';
import { SERVICES, type Service } from './services.js';

function serviceMetrics(
  service: Service,
  stack: StackProbe,
  postmasterStarts: PostmasterStarts
) {
  if (!stack.ok) {
    return {
      backend: 'none',
      runtime: 'none',
      dbPort: null,
      apiPort: null,
      postmasterStartMs: null,
      relocatedHome: null,
    };
  }
  return {
    backend: stack.backend,
    runtime: stack.runtime,
    dbPort: urlPort(stack.dbUrl) ?? null,
    apiPort: stack.apiUrl ? (urlPort(stack.apiUrl) ?? null) : null,
    postmasterStartMs:
      service === 'legacy-import' ? null : postmasterStarts[service],
    relocatedHome: stack.relocatedHome ?? null,
  };
}

export async function checkMetrics(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  marker: LocalStackEnvironmentMarker | undefined,
  commands: readonly string[],
  invocations: readonly FleetInvocation[],
  cliDetourCommands: readonly string[],
  stackList: StackListProbe,
  stacks: Record<Service, StackProbe>,
  postmasterStarts: PostmasterStarts,
  cliOverride: readonly string[] = []
): Promise<CheckResult> {
  const services = Object.fromEntries(
    SERVICES.map((service) => [
      service,
      serviceMetrics(service, stacks[service], postmasterStarts),
    ])
  ) as Record<Service, ReturnType<typeof serviceMetrics>>;
  const attemptedStart = Object.fromEntries(
    SERVICES.map((service) => [
      service,
      lifecycleEvents(invocations, service).some(
        (event) => event.kind === 'start'
      ),
    ])
  ) as Record<Service, boolean>;
  const checkoutMs = services['checkout-service'].postmasterStartMs;
  const paymentsMs = services['payments-api'].postmasterStartMs;

  const metrics = {
    cliVersion: await readCliVersion(ctx),
    cliOverride,
    cliRunnerUnverified: listUnverifiedRunners(invocations),
    channel: marker?.channel ?? 'pinned',
    services,
    attemptedStart,
    attemptedAnyStart: invocations.some(isStartInvocation),
    legacyTeardown: findLegacyLifecycle(invocations).outcome,
    setupCompletedAt: findSetup(invocations)?.anchor.at ?? null,
    evidence: {
      checkoutRestarted: decideCheckoutRestart(invocations, checkoutMs)
        .evidence,
      paymentsUntouched: decidePaymentsUntouched(invocations, paymentsMs)
        .evidence,
    },
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
