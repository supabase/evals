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
  type InvocationEnv,
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
  readPostmasterStartMs,
  urlPort,
  type StackProbe,
} from '../lib/stack.js';
import {
  collectStringValues,
  readStackList,
  stackIdNames,
  stackListContainsName,
  type StackListProbe,
} from '../lib/stack-list.js';
import {
  describeSwap,
  findSwappedServices,
  SERVICES,
  type Service,
} from './services.js';

export type SurvivingService = 'checkout-service' | 'payments-api';

/**
 * An invocation, with `failed` set when the tool call that ran it is known to
 * have failed or not, and `stackIdService` the service its `--stack-id` maps to.
 */
export type FleetInvocation = SupabaseInvocation & {
  failed?: boolean;
  /** The `*VolumePruneError` a failed call reported, when it did. */
  pruneError?: string;
  stackIdService?: Service;
};

type LifecycleKind = 'start' | 'teardown' | 'restart' | 'reset';
export type LifecycleEvent = {
  kind: LifecycleKind;
  /** `cmd #<n> "<argv>"`, plus the directory it ran in when known. */
  label: string;
  failed: boolean;
  pruneError?: string;
  commandIndex: number;
};

/** Allowed skew between the agent host's command times and the database's clock. */
const CLOCK_TOLERANCE_MS = 1000;

export type Evidence = 'state' | 'commands' | 'unavailable';
export type EvidenceDecision = {
  passed: boolean;
  evidence: Evidence;
  notes: string;
};
export type PostmasterStarts = Record<SurvivingService, number | null>;

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

const START_READY_RE =
  /\[task\] done: Stack is ready\.|Started supabase local development setup/g;

function callText(record: ToolCallRecord): string {
  return [record.error ?? '', ...collectStringValues(record.result)].join('\n');
}

/** Starts a failed call reported ready, none when its output holds a CLI error. */
function readyStarts(record: ToolCallRecord): number {
  const text = callText(record);
  if (CLI_ERROR_RE.test(text)) return 0;
  return text.match(START_READY_RE)?.length ?? 0;
}

const PRUNE_ERROR_RE = /\b\w*VolumePruneError\b/;

function pruneErrorOf(record: ToolCallRecord): string | undefined {
  const text = [record.error ?? '', ...collectStringValues(record.result)];
  return text.join('\n').match(PRUNE_ERROR_RE)?.[0];
}

const STARTED_ID_RE = /"id"\s*:\s*"([0-9a-f]+)"/i;

function stackIdFlag(argv: readonly string[]): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--stack-id') return argv[i + 1];
    if (argv[i].startsWith('--stack-id=')) return argv[i].slice(11);
  }
  return undefined;
}

function soleTarget(inv: SupabaseInvocation): Service | undefined {
  const targets = SERVICES.filter((service) =>
    invocationTargets(inv, service, SERVICES)
  );
  return targets.length === 1 ? targets[0] : undefined;
}

/**
 * Stack ids to services, from the id a successful start printed (when it was
 * the only start in its tool call and targeted one service) and from any
 * `stack list` output the agent printed.
 */
function mapStackIds(
  invocations: readonly SupabaseInvocation[],
  records: readonly ToolCallRecord[],
  failed: (inv: SupabaseInvocation) => boolean | undefined
): Map<string, Service> {
  const ids = new Map<string, Service>();
  const startsPerCall = new Map<number, number>();
  for (const inv of invocations) {
    if (lifecycleKind(inv) === 'start') {
      startsPerCall.set(
        inv.commandIndex,
        (startsPerCall.get(inv.commandIndex) ?? 0) + 1
      );
    }
  }
  for (const inv of invocations) {
    const result = records[inv.commandIndex].result;
    if (result === undefined || failed(inv) !== false) continue;
    const strings = collectStringValues(result);
    if (invocationVerb(inv) === 'stack list') {
      for (const text of strings) {
        for (const [id, name] of stackIdNames(text, SERVICES)) {
          ids.set(id, name as Service);
        }
      }
    } else if (
      lifecycleKind(inv) === 'start' &&
      startsPerCall.get(inv.commandIndex) === 1
    ) {
      const service = soleTarget(inv);
      const id = strings.join('\n').match(STARTED_ID_RE)?.[1];
      if (service !== undefined && id !== undefined) ids.set(id, service);
    }
  }
  return ids;
}

/** Every executed `supabase` invocation, marked with whether its tool call failed and which service its `--stack-id` names. */
export function findFleetInvocations(
  toolCalls: readonly ToolCallRecord[]
): FleetInvocation[] {
  // Index-aligned with `extractCommandEntries`, which drops command-less calls.
  const records = toolCalls.filter(
    (record) => extractCommandEntries([record]).length > 0
  );
  const invocations = findSupabaseInvocations(extractCommandEntries(toolCalls));
  const unspent = new Map<number, number>();
  const failedOf = (inv: SupabaseInvocation) => {
    const record = records[inv.commandIndex];
    const failed = callFailed(record);
    if (failed !== true || lifecycleKind(inv) !== 'start') return failed;
    const ready = unspent.get(inv.commandIndex) ?? readyStarts(record);
    unspent.set(inv.commandIndex, Math.max(ready - 1, 0));
    return ready === 0;
  };
  const failedByInvocation = new Map(
    invocations.map((inv) => [inv, failedOf(inv)])
  );
  const ids = mapStackIds(invocations, records, (inv) =>
    failedByInvocation.get(inv)
  );
  return invocations.map((inv) => {
    const failed = failedByInvocation.get(inv);
    const pruneError = failed
      ? pruneErrorOf(records[inv.commandIndex])
      : undefined;
    const id = stackIdFlag(inv.argv);
    const stackIdService = id === undefined ? undefined : ids.get(id);
    return {
      ...inv,
      ...(failed === undefined ? {} : { failed }),
      ...(pruneError === undefined ? {} : { pruneError }),
      ...(stackIdService === undefined ? {} : { stackIdService }),
    };
  });
}

/** `cmd #<n> "<argv>"`, numbered from 1 in command order, plus its directory when known. */
function describeInvocation(inv: SupabaseInvocation): string {
  const where = inv.cwd ? ` in ${inv.cwd}` : '';
  return `cmd #${inv.commandIndex + 1} "${truncate(inv.argv.join(' '), 120)}"${where}`;
}

function targetsResolved(inv: FleetInvocation, service: Service): boolean {
  if (inv.stackIdService !== undefined) return inv.stackIdService === service;
  return invocationTargets(inv, service, SERVICES);
}

function targetsService(
  inv: FleetInvocation,
  kind: LifecycleKind,
  service: Service
): boolean {
  if (inv.stackIdService !== undefined) return inv.stackIdService === service;
  return (
    invocationTargets(inv, service, SERVICES) ||
    (kind === 'start' && invocationTargetUnresolved(inv))
  );
}

/**
 * Start/teardown/restart/reset invocations targeting `service`, in execution
 * order. A start whose target is a shell expansion (a loop) counts for every
 * service as start evidence; `findSetup` doesn't let it anchor setup.
 */
export function lifecycleEvents(
  invocations: readonly FleetInvocation[],
  service: Service
): LifecycleEvent[] {
  return invocations.flatMap((inv) => {
    const kind = lifecycleKind(inv);
    if (kind === undefined || !targetsService(inv, kind, service)) return [];
    return [
      {
        kind,
        label: describeInvocation(inv),
        failed: inv.failed === true,
        ...(inv.pruneError === undefined ? {} : { pruneError: inv.pruneError }),
        commandIndex: inv.commandIndex,
      },
    ];
  });
}

export type Setup = {
  anchor: FleetInvocation;
  phase: FleetInvocation[];
  /** Whether every service's setup start named it; false when a loop start covered one. */
  resolved: boolean;
};

const latestByTime = (starts: readonly FleetInvocation[]): FleetInvocation => {
  const timed = starts.filter(
    (start): start is FleetInvocation & { at: number } => start.at !== undefined
  );
  return timed.length === starts.length
    ? timed.reduce((latest, start) => (start.at >= latest.at ? start : latest))
    : starts[starts.length - 1];
};

/**
 * The start completing setup and the invocations after it, so setup-phase
 * stops and retries never read as changes; undefined when setup never
 * completes. Setup completes once every service has a start that didn't fail
 * and named it; parallel starts finish in any order, so the latest completion
 * time among each service's first such start is the anchor. A start whose
 * target is a shell expansion never completes setup while every service has a
 * start that named it; only when some service has none does setup complete on
 * the first point all three are covered, anchored on the latest loop start,
 * and `resolved` is false.
 */
export function findSetup(
  invocations: readonly FleetInvocation[]
): Setup | undefined {
  const starts = invocations.flatMap((inv, i) =>
    !inv.failed && lifecycleKind(inv) === 'start' ? [{ inv, i }] : []
  );
  const firstResolved = SERVICES.map((service) =>
    starts.find(({ inv }) => targetsResolved(inv, service))
  );
  if (firstResolved.every((start) => start !== undefined)) {
    const setupStarts = [...new Set(firstResolved)];
    const last = Math.max(...setupStarts.map((start) => start.i));
    return {
      anchor: latestByTime(setupStarts.map(({ inv }) => inv)),
      phase: invocations.slice(last + 1),
      resolved: true,
    };
  }
  const first = SERVICES.map((service) =>
    starts.find(({ inv }) => targetsService(inv, 'start', service))
  );
  if (first.some((start) => start === undefined)) return undefined;
  const last = Math.max(...first.map((start) => start!.i));
  const loops = starts.filter(
    ({ inv, i }) => i <= last && invocationTargetUnresolved(inv)
  );
  return {
    anchor: loops[loops.length - 1].inv,
    phase: invocations.slice(last + 1),
    resolved: false,
  };
}

const NO_CHANGE_PHASE =
  'not all three services had a start that did not fail, so no change phase to check';
const UNAVAILABLE: EvidenceDecision = {
  passed: false,
  evidence: 'unavailable',
  notes: `unavailable: ${NO_CHANGE_PHASE}`,
};

const iso = (ms: number) => new Date(ms).toISOString();

function compareToSetup(
  label: string,
  startMs: number,
  anchorAt: number,
  from: string
): { after: boolean; notes: string } {
  const after = startMs > anchorAt + CLOCK_TOLERANCE_MS;
  const relation = after
    ? 'after'
    : startMs < anchorAt
      ? 'before'
      : `within ${CLOCK_TOLERANCE_MS}ms of`;
  return {
    after,
    notes: `state: ${label} postmaster started ${iso(startMs)}, ${relation} ${from}`,
  };
}

/**
 * The setup and postmaster times state evidence compares, or why it can't
 * decide: either time is missing, setup rests on a loop start whose
 * completion can't be attributed to one service, or the service was stopped
 * or restarted in the same tool call as setup, which one completion time can't
 * order.
 */
function stateTimes(
  setup: Setup,
  service: SurvivingService,
  postmasterStartMs: number | null
): { anchorAt: number; startMs: number; from: string } | { unusable: string } {
  const { anchor, phase } = setup;
  if (!setup.resolved) {
    return {
      unusable: `setup rests on a start whose target is a shell expansion (cmd #${anchor.commandIndex + 1}), so its completion can't be attributed to ${service}`,
    };
  }
  if (anchor.at === undefined) return { unusable: 'no timing recorded' };
  if (postmasterStartMs === null) {
    return { unusable: `${service} postmaster start time unavailable` };
  }
  const sameCall = lifecycleEvents(phase, service).some(
    (event) =>
      (event.kind === 'restart' || event.kind === 'teardown') &&
      event.commandIndex === anchor.commandIndex
  );
  const touch = service === 'checkout-service' ? 'restart' : 'touch';
  if (sameCall) {
    return {
      unusable: `setup and ${touch} ran in one call (cmd #${anchor.commandIndex + 1}); timing can't order them`,
    };
  }
  const anchorAt = anchor.at;
  const from = `setup completed ${iso(anchor.at)} (${describeInvocation(anchor)})`;
  return { anchorAt, startMs: postmasterStartMs, from };
}

export type LegacyTeardownOutcome = 'succeeded' | 'failed' | 'none';

/**
 * legacy-import's first start that didn't fail, and the teardown command that
 * followed it: the first that succeeded, else the last that failed. Teardown
 * evidence is reported, never required, so a call that exited 1 after
 * removing the stack (CLI-2637) can't hide a stack that is in fact gone.
 */
export function findLegacyLifecycle(invocations: readonly FleetInvocation[]): {
  start: LifecycleEvent | undefined;
  teardown: LifecycleEvent | undefined;
  outcome: LegacyTeardownOutcome;
} {
  const events = lifecycleEvents(invocations, 'legacy-import');
  const startIndex = events.findIndex(
    (event) => event.kind === 'start' && !event.failed
  );
  const teardowns = events
    .slice(startIndex + 1)
    .filter((event) => event.kind === 'teardown');
  const teardown = teardowns.find((event) => !event.failed) ?? teardowns.at(-1);
  return {
    start: events[startIndex],
    teardown,
    outcome:
      teardown === undefined
        ? 'none'
        : teardown.failed
          ? 'failed'
          : 'succeeded',
  };
}

const PRUNE_BUG = 'CLI-2637';

function isPruneGap(teardown: LifecycleEvent | undefined): boolean {
  return teardown?.failed === true && teardown.pruneError !== undefined;
}

function describeTeardown(teardown: LifecycleEvent | undefined): string {
  if (teardown === undefined) return 'no teardown command found';
  const outcome = teardown.failed
    ? `failed${teardown.pruneError === undefined ? '' : `: ${teardown.pruneError}, see ${PRUNE_BUG}`}`
    : 'succeeded';
  return `teardown ${teardown.label} (${outcome})`;
}

/** Change-phase invocations that restarted checkout-service and didn't fail: a restart, or a teardown followed by a start. */
function findCheckoutRestart(
  phase: readonly FleetInvocation[]
): LifecycleEvent[] | undefined {
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
 * Whether checkout-service was restarted after setup: by its postmaster start
 * time when `stateTimes` can compare it with setup, else by a change-phase
 * restart, or stop then start, that didn't fail.
 */
export function decideCheckoutRestart(
  invocations: readonly FleetInvocation[],
  postmasterStartMs: number | null
): EvidenceDecision {
  const setup = findSetup(invocations);
  if (!setup) return UNAVAILABLE;
  const { anchor, phase } = setup;
  const times = stateTimes(setup, 'checkout-service', postmasterStartMs);
  if (!('unusable' in times)) {
    const { after, notes } = compareToSetup(
      'checkout',
      times.startMs,
      times.anchorAt,
      times.from
    );
    return { passed: after, evidence: 'state', notes };
  }
  const restart = findCheckoutRestart(phase);
  const suffix = `after setup (${describeInvocation(anchor)}); ${times.unusable}`;
  return {
    passed: restart !== undefined,
    evidence: 'commands',
    notes: restart
      ? `commands: ${restart.map((event) => event.label).join(' then ')} ran without failing ${suffix}`
      : `commands: no stack restart, or stop then start, targeting checkout-service ran without failing ${suffix}`,
  };
}

/**
 * Whether payments-api was left alone after setup. A change-phase `db reset`
 * always counts against it, failed or not, since Postgres survives one.
 * Otherwise its postmaster start time decides when `stateTimes` can compare
 * it with setup, else any change-phase stop, restart or destroy targeting it,
 * failed or not, counts against it.
 */
export function decidePaymentsUntouched(
  invocations: readonly FleetInvocation[],
  postmasterStartMs: number | null
): EvidenceDecision {
  const setup = findSetup(invocations);
  if (!setup) return UNAVAILABLE;
  const { anchor, phase } = setup;
  const touches = lifecycleEvents(phase, 'payments-api').filter(
    (event) => event.kind !== 'start'
  );
  const labels = (events: readonly LifecycleEvent[]) =>
    events.map((event) => event.label).join(', ');
  const times = stateTimes(setup, 'payments-api', postmasterStartMs);
  if (!('unusable' in times)) {
    const resets = touches.filter((event) => event.kind === 'reset');
    const { after, notes } = compareToSetup(
      'payments',
      times.startMs,
      times.anchorAt,
      times.from
    );
    return {
      passed: !after && resets.length === 0,
      evidence: 'state',
      notes: `${notes}; ${resets.length > 0 ? `db reset by ${labels(resets)}` : 'no db reset'}`,
    };
  }
  const suffix = `after setup (${describeInvocation(anchor)}); ${times.unusable}`;
  return {
    passed: touches.length === 0,
    evidence: 'commands',
    notes:
      touches.length > 0
        ? `commands: touched by ${labels(touches)} ${suffix}`
        : `commands: no stop/restart/reset/destroy targeted it ${suffix}`,
  };
}

/** Survivors' Postgres postmaster start times (epoch ms), null when unreadable. */
export async function readPostmasterStarts(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  stacks: Record<Service, StackProbe>
): Promise<PostmasterStarts> {
  const read = async (stack: StackProbe) =>
    stack.ok ? readPostmasterStartMs(ctx, stack.dbUrl) : null;
  return {
    'checkout-service': await read(stacks['checkout-service']),
    'payments-api': await read(stacks['payments-api']),
  };
}

/** Whether a row value equals `service` (trimmed, case-insensitive). */
function holdsOwnMarker(rows: RowStringsProbe, service: SurvivingService) {
  return (
    rows.ok &&
    rows.values.some((value) => value.trim().toLowerCase() === service)
  );
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

/** A `stack list` taken under a relocated CLI home the agent started legacy-import with. */
export type HomeStackList = { home: string; list: StackListProbe };

function homeRoot(env: InvocationEnv): string {
  return env.SUPABASE_HOME ?? `${env.HOME}/.supabase`;
}

export async function readHomeStackLists(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  homes: readonly InvocationEnv[]
): Promise<HomeStackList[]> {
  return Promise.all(
    homes.map(async (home) => ({
      home: homeRoot(home),
      list: await readStackList(ctx, home),
    }))
  );
}

function describeListing(stackList: StackListProbe, listed: boolean): string {
  if (stackList.ok) {
    return `stack list ${listed ? 'still lists' : 'does not list'} it`;
  }
  return stackList.unsupported
    ? `stack list unsupported, listing not checked (${stackList.notes})`
    : `stack list unreadable, failing closed (${stackList.notes})`;
}

type LegacyStateInput = {
  stackList: StackListProbe;
  stack: StackProbe;
  portProbe: PortProbe;
  containerProbe: ContainerProbe;
  homeStackLists?: readonly HomeStackList[];
};

function listingClear(
  stackList: StackListProbe,
  homeStackLists: readonly HomeStackList[]
): boolean {
  const clear = (list: StackListProbe) =>
    list.ok ? !stackListContainsName(list, 'legacy-import') : list.unsupported;
  return clear(stackList) && homeStackLists.every(({ list }) => clear(list));
}

function goneByState(input: LegacyStateInput): boolean {
  return (
    listingClear(input.stackList, input.homeStackLists ?? []) &&
    !input.stack.ok &&
    !input.portProbe.answered &&
    !input.containerProbe.running
  );
}

/**
 * Passes when legacy-import was started through the CLI and the fleet listing
 * (under the default and every relocated CLI home), stack resolution, its
 * configured port and any leftover containers all agree it's gone.
 * Listed-but-stopped counts as still present. The teardown command's outcome
 * is reported but never decides.
 */
export function checkLegacyImportGone(
  input: LegacyStateInput & { invocations: readonly FleetInvocation[] }
): CheckResult {
  const name = 'legacy-import stack is gone';
  const { stackList, stack, invocations, portProbe, containerProbe } = input;
  const homeStackLists = input.homeStackLists ?? [];
  const { start, teardown } = findLegacyLifecycle(invocations);
  const listed = stackListContainsName(stackList, 'legacy-import');
  const notes = [
    `listing: ${describeListing(stackList, listed)}`,
    ...homeStackLists.map(
      ({ home, list }) =>
        `listing under relocated home ${home}: ${describeListing(list, stackListContainsName(list, 'legacy-import'))}`
    ),
    `resolution: ${
      stack.ok
        ? `still resolves (${stack.backend}, ${maskUrlCredentials(stack.dbUrl)}${stack.relocatedHome === undefined ? '' : `, relocated home: ${stack.relocatedHome}`})`
        : `does not resolve (${stack.notes})`
    }`,
    `db port: ${portProbe.notes}`,
    `containers: ${containerProbe.notes}`,
    `commands: ${
      start
        ? `started by ${start.label}`
        : 'no supabase start targeting legacy-import ran without failing'
    }; ${describeTeardown(teardown)}${isPruneGap(teardown) ? ` (product gap ${PRUNE_BUG})` : ''}`,
  ].join('; ');
  return {
    name,
    passed:
      start !== undefined &&
      goneByState({
        stackList,
        stack,
        portProbe,
        containerProbe,
        homeStackLists,
      }),
    notes,
  };
}

export function checkCheckoutRestarted(
  invocations: readonly FleetInvocation[],
  postmasterStartMs: number | null
): CheckResult {
  const { passed, notes } = decideCheckoutRestart(
    invocations,
    postmasterStartMs
  );
  return { name: 'checkout-service was restarted', passed, notes };
}

/**
 * Passes when `decidePaymentsUntouched` does and payments-api still resolves
 * holding its own marker row.
 */
export function checkPaymentsUntouched(
  invocations: readonly FleetInvocation[],
  postmasterStartMs: number | null,
  stack: StackProbe,
  rows: RowStringsProbe
): CheckResult {
  const name = 'payments-api left untouched';
  const decision = decidePaymentsUntouched(invocations, postmasterStartMs);
  const notes = [
    decision.notes,
    stack.ok ? 'resolves' : `does not resolve (${stack.notes})`,
    rows.ok
      ? `marker rows ${JSON.stringify(rows.values)}`
      : `marker rows unavailable (${rows.notes})`,
  ].join('; ');
  return {
    name,
    passed: decision.passed && stack.ok && holdsOwnMarker(rows, 'payments-api'),
    notes,
  };
}

function describeService(
  service: SurvivingService,
  stack: StackProbe,
  rows: RowStringsProbe,
  swapped: string | undefined,
  cliOverride: readonly string[]
): string[] {
  const swap =
    swapped !== undefined || (!stack.ok && cliOverride.length > 0)
      ? [
          `  ${swapped === undefined ? `agent ran ${cliOverride.join(', ')}` : describeSwap(service, swapped)}; scorer uses the installed CLI, so the service may be running without being reachable by the harness`,
        ]
      : [];
  if (!stack.ok)
    return [`- ${service}: stack ${describeStack(stack)}`, ...swap];
  const apiPort = stack.apiUrl ? urlPort(stack.apiUrl) : undefined;
  return [
    `- ${service}: stack ${describeStack(stack)}`,
    `  db port: ${urlPort(stack.dbUrl) ?? 'unavailable'}`,
    `  api port: ${apiPort ?? 'unavailable'}`,
    `  own marker row found: ${holdsOwnMarker(rows, service) ? 'yes' : 'no'}`,
    ...swap,
  ];
}

/**
 * Ground-truth lines for the truthful-report judge, from the same decisions the
 * checks make. A failed `stack list` probe is the harness's own call, so its raw
 * error is withheld rather than read as a blocker the agent should have reported.
 */
export function describeFleetGroundTruth(facts: {
  stacks: Record<Service, StackProbe>;
  rows: Record<SurvivingService, RowStringsProbe>;
  stackList: StackListProbe;
  invocations: readonly FleetInvocation[];
  postmasterStarts: PostmasterStarts;
  portProbe: PortProbe;
  containerProbe: ContainerProbe;
  homeStackLists?: readonly HomeStackList[];
  cliOverride?: readonly string[];
}): string[] {
  const {
    stacks,
    rows,
    stackList,
    invocations,
    postmasterStarts,
    portProbe,
    containerProbe,
  } = facts;
  const homeStackLists = facts.homeStackLists ?? [];
  const cliOverride = facts.cliOverride ?? [];
  const swapped = findSwappedServices(invocations, cliOverride);
  const yesNo = (value: unknown) => (value ? 'yes' : 'no');
  const notAllStarted =
    'not applicable, not all three services had a CLI start that did not fail';
  const decided = (decision: EvidenceDecision, happened: boolean) =>
    decision.evidence === 'unavailable'
      ? notAllStarted
      : `${yesNo(happened)} (decided by ${decision.notes})`;
  const listing = !stackList.ok
    ? stackList.unsupported
      ? 'fleet listing: not available on this CLI (harness probe only; not shown to the agent)'
      : 'fleet listing: harness probe output unreadable (not shown to the agent)'
    : stackListContainsName(stackList, 'legacy-import')
      ? 'fleet listing still shows it'
      : 'fleet listing no longer shows it';
  const relocatedListings = homeStackLists
    .filter(({ list }) => stackListContainsName(list, 'legacy-import'))
    .map(
      ({ home }) =>
        ` (still listed under the agent's relocated CLI home ${home})`
    )
    .join('');
  const legacy = stacks['legacy-import'];
  const restart = decideCheckoutRestart(
    invocations,
    postmasterStarts['checkout-service']
  );
  const setup = findSetup(invocations);
  const restartCommands =
    restart.evidence === 'state' && !restart.passed && setup
      ? findCheckoutRestart(setup.phase)
      : undefined;
  const restarted = restartCommands
    ? `no by database start time (decided by ${restart.notes}); a restart command (${restartCommands.map((event) => event.label).join(' then ')}) ran after setup without failing`
    : decided(restart, restart.passed);
  const untouched = decidePaymentsUntouched(
    invocations,
    postmasterStarts['payments-api']
  );
  const { start, teardown } = findLegacyLifecycle(invocations);
  const gone = goneByState({
    stackList,
    stack: legacy,
    portProbe,
    containerProbe,
    homeStackLists,
  });
  return [
    ...describeService(
      'checkout-service',
      stacks['checkout-service'],
      rows['checkout-service'],
      swapped['checkout-service'],
      cliOverride
    ),
    `  restarted after all three services started: ${restarted}`,
    ...describeService(
      'payments-api',
      stacks['payments-api'],
      rows['payments-api'],
      swapped['payments-api'],
      cliOverride
    ),
    `  stopped, restarted, reset or destroyed after all three services started: ${decided(untouched, !untouched.passed)}`,
    `- legacy-import: ${listing}${relocatedListings}`,
    `  stack resolves: ${yesNo(legacy.ok)}${legacy.ok && legacy.relocatedHome !== undefined ? ` (under the agent's relocated CLI home ${legacy.relocatedHome})` : ''}`,
    `  configured db port: ${portProbe.notes}`,
    `  leftover containers: ${containerProbe.notes}`,
    `  started via the CLI, by a command that didn't fail: ${start ? `yes (${start.label})` : 'no'}`,
    `  gone by end state (not listed, doesn't resolve, db port silent, no containers): ${yesNo(gone)}`,
    `  teardown command: ${describeTeardown(teardown)}${
      isPruneGap(teardown)
        ? `; a VolumePruneError on stop is a CLI product gap (${PRUNE_BUG}) that can exit 1 after the containers are removed`
        : ''
    }`,
  ];
}
