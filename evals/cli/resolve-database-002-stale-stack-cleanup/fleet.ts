import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import {
  invocationTargetUnresolved,
  invocationTargets,
  invocationVerb,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import type { RowStringsProbe } from '../lib/markers.js';
import { errorMessage, shellQuote, truncate } from '../lib/shell.js';
import {
  describeStack,
  maskUrlCredentials,
  urlPort,
  type StackProbe,
} from '../lib/stack.js';
import {
  stackListContainsName,
  type StackListProbe,
} from '../lib/stack-list.js';
import type { Service } from './services.js';

export type SurvivingService = 'checkout-service' | 'payments-api';

type LifecycleKind = 'start' | 'teardown' | 'restart';
export type LifecycleEvent = { kind: LifecycleKind; command: string };

const VERB_KINDS = new Map<string, LifecycleKind>([
  ['start', 'start'],
  ['stack start', 'start'],
  ['stop', 'teardown'],
  ['destroy', 'teardown'],
  ['down', 'teardown'],
  ['stack stop', 'teardown'],
  ['stack destroy', 'teardown'],
  ['restart', 'restart'],
  ['stack restart', 'restart'],
]);

/** Whether the invocation is a `supabase start` or `supabase stack start`, whatever it targets. */
export function isStartInvocation(inv: SupabaseInvocation): boolean {
  return VERB_KINDS.get(invocationVerb(inv) ?? '') === 'start';
}

/**
 * Start/teardown/restart invocations targeting `service`, in execution order.
 * A start whose target is a shell expansion (a loop) counts for every service,
 * since start evidence only guards against a vacuous teardown.
 */
export function lifecycleEvents(
  invocations: readonly SupabaseInvocation[],
  service: Service
): LifecycleEvent[] {
  return invocations.flatMap((inv) => {
    const kind = VERB_KINDS.get(invocationVerb(inv) ?? '');
    if (kind === undefined) return [];
    const targeted =
      invocationTargets(inv, service) ||
      (kind === 'start' && invocationTargetUnresolved(inv));
    if (!targeted) return [];
    const command = inv.cwd
      ? `(in ${inv.cwd}) ${inv.argv.join(' ')}`
      : inv.argv.join(' ');
    return [{ kind, command: truncate(command, 160) }];
  });
}

function afterFirstStart(events: readonly LifecycleEvent[]) {
  const start = events.findIndex((event) => event.kind === 'start');
  return { start: events[start], after: events.slice(start + 1) };
}

/** The start and later teardown of legacy-import, if both were invoked in that order. */
export function findLegacyTeardown(
  invocations: readonly SupabaseInvocation[]
): { start: LifecycleEvent; teardown: LifecycleEvent } | undefined {
  const { start, after } = afterFirstStart(
    lifecycleEvents(invocations, 'legacy-import')
  );
  const teardown = after.find((event) => event.kind === 'teardown');
  return start && teardown ? { start, teardown } : undefined;
}

/** Invocations that restarted checkout-service after its first start: a restart, or a teardown followed by a start. */
export function findCheckoutRestart(
  invocations: readonly SupabaseInvocation[]
): LifecycleEvent[] | undefined {
  const { start, after } = afterFirstStart(
    lifecycleEvents(invocations, 'checkout-service')
  );
  if (!start) return undefined;
  const restart = after.find((event) => event.kind === 'restart');
  if (restart) return [restart];
  const stop = after.findIndex((event) => event.kind === 'teardown');
  const restartedBy = after
    .slice(stop + 1)
    .find((event) => event.kind === 'start');
  return stop >= 0 && restartedBy ? [after[stop], restartedBy] : undefined;
}

/** Teardown or restart invocations targeting payments-api after its first start, or anywhere when no start is attributable. */
export function findPaymentsTouches(
  invocations: readonly SupabaseInvocation[]
): LifecycleEvent[] {
  return afterFirstStart(
    lifecycleEvents(invocations, 'payments-api')
  ).after.filter((event) => event.kind !== 'start');
}

export function readConfigDbPort(toml: string): number | undefined {
  let section: string | undefined;
  for (const line of toml.split('\n')) {
    const header = line.match(/^\s*\[([^\]]+)\]/);
    if (header) {
      section = header[1].trim();
      continue;
    }
    const port = section === 'db' && line.match(/^\s*port\s*=\s*(\d+)/);
    if (port) return Number(port[1]);
  }
  return undefined;
}

export type PortProbe = { answered: boolean; notes: string };

/**
 * Whether Postgres still answers on legacy-import's configured `[db] port`,
 * catching a database left running that the CLI no longer reports. Skipped
 * when the port belongs to a surviving stack, which would answer instead.
 */
export async function probeLegacyDbPort(
  ctx: Pick<LocalStackEvalContext, 'exec' | 'readFile'>,
  dir: string | undefined,
  survivingDbPorts: readonly number[]
): Promise<PortProbe> {
  if (dir === undefined) {
    return { answered: false, notes: 'no legacy-import config.toml to read' };
  }
  try {
    const port = readConfigDbPort(
      await ctx.readFile(`${dir}/supabase/config.toml`)
    );
    if (port === undefined) {
      return { answered: false, notes: 'config.toml sets no [db] port' };
    }
    if (survivingDbPorts.includes(port)) {
      return {
        answered: false,
        notes: `[db] port ${port} is shared with a surviving stack; not probed`,
      };
    }
    const result = await ctx.exec(
      `psql ${shellQuote(`postgresql://postgres:postgres@127.0.0.1:${port}/postgres`)} -tAc 'select 1'`
    );
    const answered = result.ok && result.stdout.trim() === '1';
    return {
      answered,
      notes: `[db] port ${port} ${answered ? 'still answers select 1' : 'does not answer'}`,
    };
  } catch (error) {
    return { answered: false, notes: errorMessage(error) };
  }
}

/**
 * Passes when the CLI tore legacy-import down after starting it, and the
 * fleet listing, stack resolution and its configured port all agree it's
 * gone. Listed-but-stopped counts as still present.
 */
export function checkLegacyImportGone(input: {
  stackList: StackListProbe;
  stack: StackProbe;
  invocations: readonly SupabaseInvocation[];
  portProbe: PortProbe;
}): CheckResult {
  const name = 'legacy-import stack is gone';
  const { stackList, stack, invocations, portProbe } = input;
  const teardown = findLegacyTeardown(invocations);
  const listed = stackListContainsName(stackList, 'legacy-import');
  const notes = [
    teardown
      ? `started by \`${teardown.start.command}\`, torn down by \`${teardown.teardown.command}\``
      : 'no supabase start followed by a stop/destroy targeting legacy-import was executed',
    stackList.ok
      ? `stack list ${listed ? 'still lists' : 'does not list'} it`
      : `stack list unavailable, listing not checked (${stackList.notes})`,
    stack.ok
      ? `still resolves (${stack.backend}, ${maskUrlCredentials(stack.dbUrl)})`
      : `does not resolve (${stack.notes})`,
    portProbe.notes,
  ].join('; ');
  return {
    name,
    passed:
      teardown !== undefined && !listed && !stack.ok && !portProbe.answered,
    notes,
  };
}

export function checkCheckoutRestarted(
  invocations: readonly SupabaseInvocation[]
): CheckResult {
  const name = 'checkout-service was restarted';
  const restart = findCheckoutRestart(invocations);
  return {
    name,
    passed: restart !== undefined,
    notes: restart
      ? restart.map((event) => `\`${event.command}\``).join(' then ')
      : 'no restart, or stop then start, targeting checkout-service after its first start',
  };
}

/**
 * Passes when nothing stopped, restarted or destroyed payments-api after it
 * was first started, and it still resolves holding its own marker row.
 */
export function checkPaymentsUntouched(
  invocations: readonly SupabaseInvocation[],
  stack: StackProbe,
  rows: RowStringsProbe
): CheckResult {
  const name = 'payments-api left untouched';
  const touches = findPaymentsTouches(invocations);
  const holdsMarker =
    rows.ok &&
    rows.values.some((value) => value.toLowerCase().includes('payments-api'));
  const notes = [
    touches.length === 0
      ? 'no stop/restart/destroy targeted it after its first start'
      : `touched by ${touches.map((event) => `\`${event.command}\``).join(', ')}`,
    stack.ok ? 'resolves' : `does not resolve (${stack.notes})`,
    rows.ok
      ? `marker rows ${JSON.stringify(rows.values)}`
      : `marker rows unavailable (${rows.notes})`,
  ].join('; ');
  return {
    name,
    passed: touches.length === 0 && stack.ok && holdsMarker,
    notes,
  };
}

function describeService(
  service: SurvivingService,
  stack: StackProbe,
  rows: RowStringsProbe
): string[] {
  if (!stack.ok) return [`- ${service}: stack ${describeStack(stack)}`];
  const ownMarker =
    rows.ok &&
    rows.values.some((value) => value.toLowerCase().includes(service));
  const apiPort = stack.apiUrl ? urlPort(stack.apiUrl) : undefined;
  return [
    `- ${service}: stack ${describeStack(stack)}`,
    `  db port: ${urlPort(stack.dbUrl) ?? 'unavailable'}`,
    `  api port: ${apiPort ?? 'unavailable'}`,
    `  own marker row found: ${ownMarker ? 'yes' : 'no'}`,
  ];
}

/**
 * Ground-truth lines for the truthful-report judge. A failed `stack list`
 * probe is the harness's own call, so its raw error is withheld rather than
 * read as a blocker the agent should have reported.
 */
export function describeFleetGroundTruth(facts: {
  stacks: Record<Service, StackProbe>;
  rows: Record<SurvivingService, RowStringsProbe>;
  stackList: StackListProbe;
  invocations: readonly SupabaseInvocation[];
  portProbe: PortProbe;
}): string[] {
  const { stacks, rows, stackList, invocations, portProbe } = facts;
  const yesNo = (value: unknown) => (value ? 'yes' : 'no');
  const listing = !stackList.ok
    ? 'fleet listing: not available on this CLI (harness probe only; not shown to the agent)'
    : stackListContainsName(stackList, 'legacy-import')
      ? 'fleet listing still shows it'
      : 'fleet listing no longer shows it';
  return [
    ...describeService(
      'checkout-service',
      stacks['checkout-service'],
      rows['checkout-service']
    ),
    `  restarted via the CLI after its first start: ${yesNo(findCheckoutRestart(invocations))}`,
    ...describeService(
      'payments-api',
      stacks['payments-api'],
      rows['payments-api']
    ),
    `  stopped, restarted or destroyed via the CLI after its first start: ${yesNo(findPaymentsTouches(invocations).length)}`,
    `- legacy-import: ${listing}`,
    `  stack resolves: ${yesNo(stacks['legacy-import'].ok)}`,
    `  configured db port: ${portProbe.notes}`,
    `  started then torn down via the CLI: ${yesNo(findLegacyTeardown(invocations))}`,
  ];
}
