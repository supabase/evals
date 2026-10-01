import type {
  CheckResult,
  LocalStackEvalContext,
  ToolCallRecord,
} from '@supabase-evals/core';
import {
  findSupabaseInvocations,
  invocationTargetUnresolved,
  invocationTargets,
  invocationVerb,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { extractCommandEntries } from '../lib/detours.js';
import type { RowStringsProbe } from '../lib/markers.js';
import {
  describeFailure,
  errorMessage,
  shellQuote,
  truncate,
} from '../lib/shell.js';
import {
  describeStack,
  maskUrlCredentials,
  urlPort,
  type StackProbe,
} from '../lib/stack.js';
import {
  collectStringValues,
  stackListContainsName,
  type StackListProbe,
} from '../lib/stack-list.js';
import { SERVICES, type Service } from './services.js';

export type SurvivingService = 'checkout-service' | 'payments-api';

/** An invocation, with `failed` set when the tool call that ran it is known to have failed or not. */
export type FleetInvocation = SupabaseInvocation & { failed?: boolean };

type LifecycleKind = 'start' | 'teardown' | 'restart' | 'reset';
export type LifecycleEvent = {
  kind: LifecycleKind;
  command: string;
  failed: boolean;
};

// Neither the legacy nor the beta CLI has a top-level `restart`.
const VERB_KINDS = new Map<string, LifecycleKind>([
  ['start', 'start'],
  ['stack start', 'start'],
  ['stop', 'teardown'],
  ['destroy', 'teardown'],
  ['down', 'teardown'],
  ['stack stop', 'teardown'],
  ['stack destroy', 'teardown'],
  ['stack restart', 'restart'],
]);

const CLI_ERROR_RE =
  /"_tag"\s*:\s*"Error"|unknown\s*sub-?command|unknown command/i;

function lifecycleKind(inv: SupabaseInvocation): LifecycleKind | undefined {
  const verb = invocationVerb(inv);
  if (verb === 'db' && inv.argv.includes('reset')) return 'reset';
  return VERB_KINDS.get(verb ?? '');
}

/** Failed on a non-zero exit or a CLI error in the output; undefined when the call recorded neither. */
function callFailed(record: ToolCallRecord): boolean | undefined {
  if (record.error !== undefined) return true;
  if (record.result === undefined) return undefined;
  return CLI_ERROR_RE.test(collectStringValues(record.result).join('\n'));
}

/** Every executed `supabase` invocation, marked with whether its tool call failed. */
export function findFleetInvocations(
  toolCalls: readonly ToolCallRecord[]
): FleetInvocation[] {
  // Index-aligned with `extractCommandEntries`, which drops command-less calls.
  const records = toolCalls.filter(
    (record) => extractCommandEntries([record]).length > 0
  );
  return findSupabaseInvocations(extractCommandEntries(toolCalls)).map(
    (inv) => {
      const failed = callFailed(records[inv.commandIndex]);
      return failed === undefined ? inv : { ...inv, failed };
    }
  );
}

/** Whether the invocation is a `supabase start` or `supabase stack start`, whatever it targets. */
export function isStartInvocation(inv: SupabaseInvocation): boolean {
  return lifecycleKind(inv) === 'start';
}

function targetsService(
  inv: SupabaseInvocation,
  kind: LifecycleKind,
  service: Service
): boolean {
  return (
    invocationTargets(inv, service) ||
    (kind === 'start' && invocationTargetUnresolved(inv))
  );
}

/**
 * Start/teardown/restart/reset invocations targeting `service`, in execution
 * order. A start whose target is a shell expansion (a loop) counts for every
 * service, since start evidence only guards against a vacuous teardown.
 */
export function lifecycleEvents(
  invocations: readonly FleetInvocation[],
  service: Service
): LifecycleEvent[] {
  return invocations.flatMap((inv) => {
    const kind = lifecycleKind(inv);
    if (kind === undefined || !targetsService(inv, kind, service)) return [];
    const command = inv.cwd
      ? `(in ${inv.cwd}) ${inv.argv.join(' ')}`
      : inv.argv.join(' ');
    return [
      { kind, command: truncate(command, 160), failed: inv.failed === true },
    ];
  });
}

/**
 * Invocations after the first point where every service has had a start that
 * didn't fail, so setup-phase stops and retries never read as changes;
 * undefined when that point never comes.
 */
export function changePhase(
  invocations: readonly FleetInvocation[]
): FleetInvocation[] | undefined {
  const started = new Set<Service>();
  for (const [i, inv] of invocations.entries()) {
    const kind = lifecycleKind(inv);
    if (inv.failed || kind !== 'start') continue;
    for (const service of SERVICES) {
      if (targetsService(inv, kind, service)) started.add(service);
    }
    if (started.size === SERVICES.length) return invocations.slice(i + 1);
  }
  return undefined;
}

const NO_CHANGE_PHASE =
  'not all three services had a start that did not fail, so no change phase to check';

/** A start and later teardown of legacy-import, both from tool calls that didn't fail. */
export function findLegacyTeardown(
  invocations: readonly FleetInvocation[]
): { start: LifecycleEvent; teardown: LifecycleEvent } | undefined {
  const events = lifecycleEvents(invocations, 'legacy-import').filter(
    (event) => !event.failed
  );
  const start = events.findIndex((event) => event.kind === 'start');
  if (start < 0) return undefined;
  const teardown = events
    .slice(start + 1)
    .find((event) => event.kind === 'teardown');
  return teardown ? { start: events[start], teardown } : undefined;
}

/** Change-phase invocations that restarted checkout-service and didn't fail: a restart, or a teardown followed by a start. */
export function findCheckoutRestart(
  invocations: readonly FleetInvocation[]
): LifecycleEvent[] | undefined {
  const phase = changePhase(invocations);
  if (!phase) return undefined;
  const events = lifecycleEvents(phase, 'checkout-service').filter(
    (event) => !event.failed
  );
  const restart = events.find((event) => event.kind === 'restart');
  if (restart) return [restart];
  const stop = events.findIndex((event) => event.kind === 'teardown');
  if (stop < 0) return undefined;
  const restartedBy = events
    .slice(stop + 1)
    .find((event) => event.kind === 'start');
  return restartedBy ? [events[stop], restartedBy] : undefined;
}

/**
 * Change-phase teardown, restart or reset invocations targeting payments-api,
 * failed or not; undefined when there's no change phase.
 */
export function findPaymentsTouches(
  invocations: readonly FleetInvocation[]
): LifecycleEvent[] | undefined {
  const phase = changePhase(invocations);
  return phase
    ? lifecycleEvents(phase, 'payments-api').filter(
        (event) => event.kind !== 'start'
      )
    : undefined;
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

export type ContainerProbe = { running: boolean; notes: string };

const CLI_PROJECT_LABEL = 'com.supabase.cli.project';
const LEGACY_CONTAINER_RE = /^supabase_\w+_legacy-import$/;

/**
 * Running containers the CLI labelled or named for legacy-import, probed only
 * once its directory is gone and the project-scoped lookups can't run.
 * Skipped when `docker` is unreachable: without a runtime nothing can run.
 */
export async function probeLegacyContainers(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  dir: string | undefined
): Promise<ContainerProbe> {
  if (dir !== undefined) {
    return { running: false, notes: 'directory exists; containers not probed' };
  }
  try {
    const result = await ctx.exec(
      `docker ps --format ${shellQuote(`{{.Names}}\t{{.Label "${CLI_PROJECT_LABEL}"}}`)}`
    );
    if (!result.ok) {
      return {
        running: false,
        notes: `docker unreachable, containers not probed (${describeFailure(result)})`,
      };
    }
    const leftover = result.stdout.split('\n').flatMap((line) => {
      const [name = '', project] = line.trim().split('\t');
      return project === 'legacy-import' || LEGACY_CONTAINER_RE.test(name)
        ? [name]
        : [];
    });
    return {
      running: leftover.length > 0,
      notes:
        leftover.length > 0
          ? `docker still runs ${leftover.join(', ')}`
          : 'docker runs no legacy-import containers',
    };
  } catch (error) {
    return { running: false, notes: errorMessage(error) };
  }
}

function describeListing(stackList: StackListProbe, listed: boolean): string {
  if (stackList.ok) {
    return `stack list ${listed ? 'still lists' : 'does not list'} it`;
  }
  return stackList.unsupported
    ? `stack list unsupported, listing not checked (${stackList.notes})`
    : `stack list unreadable, failing closed (${stackList.notes})`;
}

/**
 * Passes when the CLI tore legacy-import down after starting it, and the
 * fleet listing, stack resolution, its configured port and any leftover
 * containers all agree it's gone. Listed-but-stopped counts as still present.
 */
export function checkLegacyImportGone(input: {
  stackList: StackListProbe;
  stack: StackProbe;
  invocations: readonly FleetInvocation[];
  portProbe: PortProbe;
  containerProbe: ContainerProbe;
}): CheckResult {
  const name = 'legacy-import stack is gone';
  const { stackList, stack, invocations, portProbe, containerProbe } = input;
  const teardown = findLegacyTeardown(invocations);
  const listed = stackListContainsName(stackList, 'legacy-import');
  const listingClear = stackList.ok ? !listed : stackList.unsupported;
  const notes = [
    teardown
      ? `started by \`${teardown.start.command}\`, torn down by \`${teardown.teardown.command}\``
      : 'no supabase start followed by a stop/destroy targeting legacy-import ran without failing',
    describeListing(stackList, listed),
    stack.ok
      ? `still resolves (${stack.backend}, ${maskUrlCredentials(stack.dbUrl)})`
      : `does not resolve (${stack.notes})`,
    portProbe.notes,
    containerProbe.notes,
  ].join('; ');
  return {
    name,
    passed:
      teardown !== undefined &&
      listingClear &&
      !stack.ok &&
      !portProbe.answered &&
      !containerProbe.running,
    notes,
  };
}

export function checkCheckoutRestarted(
  invocations: readonly FleetInvocation[]
): CheckResult {
  const name = 'checkout-service was restarted';
  const restart = findCheckoutRestart(invocations);
  const notes = restart
    ? restart.map((event) => `\`${event.command}\``).join(' then ')
    : changePhase(invocations)
      ? 'no stack restart, or stop then start, targeting checkout-service ran without failing after all three services started'
      : NO_CHANGE_PHASE;
  return { name, passed: restart !== undefined, notes };
}

/**
 * Passes when nothing stopped, restarted, reset or destroyed payments-api
 * after all three services started, and it still resolves holding its own
 * marker row.
 */
export function checkPaymentsUntouched(
  invocations: readonly FleetInvocation[],
  stack: StackProbe,
  rows: RowStringsProbe
): CheckResult {
  const name = 'payments-api left untouched';
  const touches = findPaymentsTouches(invocations);
  const holdsMarker =
    rows.ok &&
    rows.values.some((value) => value.toLowerCase().includes('payments-api'));
  const notes = [
    touches === undefined
      ? NO_CHANGE_PHASE
      : touches.length === 0
        ? 'no stop/restart/reset/destroy targeted it after all three services started'
        : `touched by ${touches.map((event) => `\`${event.command}\``).join(', ')}`,
    stack.ok ? 'resolves' : `does not resolve (${stack.notes})`,
    rows.ok
      ? `marker rows ${JSON.stringify(rows.values)}`
      : `marker rows unavailable (${rows.notes})`,
  ].join('; ');
  return {
    name,
    passed: touches?.length === 0 && stack.ok && holdsMarker,
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
 * Ground-truth lines for the truthful-report judge, from the same evidence the
 * checks use. A failed `stack list` probe is the harness's own call, so its raw
 * error is withheld rather than read as a blocker the agent should have reported.
 */
export function describeFleetGroundTruth(facts: {
  stacks: Record<Service, StackProbe>;
  rows: Record<SurvivingService, RowStringsProbe>;
  stackList: StackListProbe;
  invocations: readonly FleetInvocation[];
  portProbe: PortProbe;
  containerProbe: ContainerProbe;
}): string[] {
  const { stacks, rows, stackList, invocations, portProbe, containerProbe } =
    facts;
  const yesNo = (value: unknown) => (value ? 'yes' : 'no');
  const notAllStarted =
    'not applicable, not all three services had a CLI start that did not fail';
  const listing = !stackList.ok
    ? stackList.unsupported
      ? 'fleet listing: not available on this CLI (harness probe only; not shown to the agent)'
      : 'fleet listing: harness probe output unreadable (not shown to the agent)'
    : stackListContainsName(stackList, 'legacy-import')
      ? 'fleet listing still shows it'
      : 'fleet listing no longer shows it';
  const touches = findPaymentsTouches(invocations);
  return [
    ...describeService(
      'checkout-service',
      stacks['checkout-service'],
      rows['checkout-service']
    ),
    `  restarted via the CLI after all three services started: ${changePhase(invocations) ? yesNo(findCheckoutRestart(invocations)) : notAllStarted}`,
    ...describeService(
      'payments-api',
      stacks['payments-api'],
      rows['payments-api']
    ),
    `  stopped, restarted, reset or destroyed via the CLI after all three services started: ${touches ? yesNo(touches.length) : notAllStarted}`,
    `- legacy-import: ${listing}`,
    `  stack resolves: ${yesNo(stacks['legacy-import'].ok)}`,
    `  configured db port: ${portProbe.notes}`,
    `  leftover containers: ${containerProbe.notes}`,
    `  started then torn down via the CLI, by commands that didn't fail: ${yesNo(findLegacyTeardown(invocations))}`,
  ];
}
