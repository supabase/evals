import type {
  CheckResult,
  LocalStackEvalContext,
  ToolCallRecord,
} from '@supabase-evals/core';
import {
  invocationFlag,
  invocationVerb,
  isStartInvocation,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { commandToolCalls } from '../lib/detours.js';
import { safely } from '../lib/metrics.js';
import { findProjectDirs } from '../lib/projects.js';
import { parseJsonObject, type StackProbe } from '../lib/stack.js';

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;

export type RequestedRuntime =
  | 'docker'
  | 'native'
  | 'podman'
  | 'auto'
  | 'invalid';
export type ResolvedRuntime = 'docker' | 'native' | 'podman' | 'unknown';
export type ActualRuntime = 'docker' | 'native' | 'none';

export type StartAttempt = {
  commandIndex: number;
  backend: 'managed' | 'legacy';
  requested: RequestedRuntime;
  resolved: ResolvedRuntime;
  ok: boolean | undefined;
  runtimeMismatch: boolean;
};

export const DOCKER_UNAVAILABLE_RE =
  /Cannot connect to the Docker daemon|Docker CLI or daemon isn't reachable|docker:\s*command not found|Executable not found in \$PATH:\s*"?docker"?|docker daemon.*not running/i;

export const RUNTIME_MISMATCH_RE = /does not match existing stack runtime/i;

// Only the managed backend prints these; the task line precedes the outcome, so it appears on failures too.
export const MANAGED_BACKEND_OUTPUT_RE =
  /"code"\s*:\s*"ExperimentalStack[A-Za-z]*"|^\[task\] start: Starting local Supabase stack/m;

const AUTO_NOTICE_RE =
  /Docker didn't answer, so this new stack uses the (Podman|native) runtime/i;
const AUTO_NOTICE_LINE_RE = new RegExp(`^.*${AUTO_NOTICE_RE.source}.*$`, 'gim');
const RUNTIME_LINE_RE = /^\s*Runtime:\s*(docker|native|podman)\b/im;
const LEGACY_SUCCESS_RE = /Started supabase local development setup/;
const START_JSON_KEY_RE = /"(?:runtime|DB_URL)"/;
const MANAGED_BANNER_RE = /^\[task\] start: Starting local Supabase stack/gm;
// The CLI's own wording; the raw Docker client errors in DOCKER_UNAVAILABLE_RE can come from the agent's probes.
const CLI_DOCKER_MESSAGE_RE = /Docker CLI or daemon isn't reachable/i;
const PORT_ALLOCATED_RE = /port is already allocated/i;
const CLI_FAILURE_MARKERS = [
  RUNTIME_MISMATCH_RE,
  /ContainerLaunchError/,
  /StackCommandStartError/,
  /Stack owner failed to start/,
  /"code"\s*:\s*"ExperimentalStack\w*Error"/,
  /^\[task\] failed:/m,
  /Try rerunning the command with --debug/,
];
const FAILURE_MARKERS = [
  DOCKER_UNAVAILABLE_RE,
  PORT_ALLOCATED_RE,
  ...CLI_FAILURE_MARKERS,
];
const NAMED_RUNTIMES = new Set(['docker', 'native', 'podman']);
const REQUESTABLE_RUNTIMES = new Set([...NAMED_RUNTIMES, 'auto']);

function runtimeName(
  value: unknown
): Exclude<ResolvedRuntime, 'unknown'> | undefined {
  const name =
    typeof value === 'object' && value !== null
      ? (value as { kind?: unknown }).kind
      : value;
  return typeof name === 'string' && NAMED_RUNTIMES.has(name)
    ? (name as Exclude<ResolvedRuntime, 'unknown'>)
    : undefined;
}

function outputOf(record: ToolCallRecord | undefined): string {
  if (record === undefined) return '';
  const result =
    typeof record.result === 'string'
      ? record.result
      : record.result === undefined
        ? ''
        : JSON.stringify(record.result);
  return [record.error, result].filter(Boolean).join('\n');
}

// The automatic-runtime notice can quote the Docker error it recovered from, so it must not read as a failure.
function withoutNotice(output: string): string {
  return output.replace(AUTO_NOTICE_LINE_RE, '');
}

function startJson(output: string): Record<string, unknown> | undefined {
  return START_JSON_KEY_RE.test(output) ? parseJsonObject(output) : undefined;
}

function reportedRuntime(output: string) {
  return (
    runtimeName(RUNTIME_LINE_RE.exec(output)?.[1]) ??
    runtimeName(startJson(output)?.runtime)
  );
}

function showsManagedBackend(output: string): boolean {
  return (
    MANAGED_BACKEND_OUTPUT_RE.test(output) ||
    reportedRuntime(output) !== undefined
  );
}

function requestedRuntime(inv: SupabaseInvocation): RequestedRuntime {
  const value = invocationFlag(inv, '--runtime');
  if (value === undefined) return 'auto';
  return REQUESTABLE_RUNTIMES.has(value)
    ? (value as RequestedRuntime)
    : 'invalid';
}

function classify(
  inv: SupabaseInvocation,
  output: string
): Pick<StartAttempt, 'backend' | 'requested'> {
  const managed =
    invocationVerb(inv) === 'stack start' ||
    inv.experimentalStack === true ||
    showsManagedBackend(output);
  if (managed) return { backend: 'managed', requested: requestedRuntime(inv) };
  return {
    backend: 'legacy',
    requested:
      invocationFlag(inv, '--runtime') === undefined ? 'docker' : 'invalid',
  };
}

function startOutcome(output: string): boolean | undefined {
  if (FAILURE_MARKERS.some((marker) => marker.test(output))) return false;
  const json = startJson(output);
  if (
    RUNTIME_LINE_RE.test(output) ||
    LEGACY_SUCCESS_RE.test(output) ||
    typeof json?.runtime === 'string' ||
    typeof json?.DB_URL === 'string'
  ) {
    return true;
  }
  return undefined;
}

type Draft = {
  inv: SupabaseInvocation;
  output: string;
  attributed: boolean;
  ownsRecordStatus: boolean;
  record: ToolCallRecord | undefined;
};

// The automatic-runtime notice prints just before its start's banner, so a chunk begins at the notice.
const START_CHUNK_RE = new RegExp(
  `^(?:.*${AUTO_NOTICE_RE.source}.*\\n)?${MANAGED_BANNER_RE.source}`,
  'gim'
);

function splitByBanner(output: string, count: number): string[] | undefined {
  const at = [...output.matchAll(START_CHUNK_RE)].map(
    (match) => match.index ?? 0
  );
  if (at.length !== count) return undefined;
  return at.map((from, i) => output.slice(from, at[i + 1]));
}

// Index-aligned with `group`; undefined marks a start that received no output.
function attributeOutput(
  group: readonly SupabaseInvocation[],
  output: string
): Array<string | undefined> {
  if (group.length === 1) return [output];
  const chunks = splitByBanner(output, group.length);
  if (chunks !== undefined) return chunks;
  const reported = reportedRuntime(output);
  const consistent = (inv: SupabaseInvocation) => {
    const requested = requestedRuntime(inv);
    return (
      reported === undefined || requested === 'auto' || requested === reported
    );
  };
  let target = group.length - 1;
  if (!consistent(group[target])) {
    for (let j = target - 1; j >= 0; j--) {
      if (consistent(group[j])) {
        target = j;
        break;
      }
    }
  }
  return group.map((_, j) => (j === target ? output : undefined));
}

function showsCliRan(output: string): boolean {
  return (
    showsManagedBackend(output) ||
    CLI_FAILURE_MARKERS.some((marker) => marker.test(output))
  );
}

// undefined: no evidence in the attempt's own output; the caller infers it from neighbouring attempts.
function resolveFromEvidence(
  requested: RequestedRuntime,
  draft: Draft,
  previous: Exclude<ResolvedRuntime, 'unknown'> | undefined
): ResolvedRuntime | undefined {
  if (requested === 'invalid') return 'unknown';
  if (requested !== 'auto') return draft.attributed ? requested : 'unknown';
  const { output } = draft;
  const notice = AUTO_NOTICE_RE.exec(output)?.[1]?.toLowerCase();
  const reported = runtimeName(notice) ?? reportedRuntime(output);
  if (reported !== undefined) return reported;
  if (CLI_DOCKER_MESSAGE_RE.test(output)) return 'docker';
  if (showsCliRan(output)) return previous ?? 'docker';
  return undefined;
}

/** The run's start attempts in order, each given the slice of its call's output that belongs to it. */
export function startTimeline(
  invocations: readonly SupabaseInvocation[],
  toolCalls: readonly ToolCallRecord[],
  stack: StackProbe
): StartAttempt[] {
  const records = commandToolCalls(toolCalls);
  const starts = invocations.filter(isStartInvocation);
  const byCall = new Map<number, number[]>();
  starts.forEach((inv, i) =>
    byCall.set(inv.commandIndex, [...(byCall.get(inv.commandIndex) ?? []), i])
  );

  const drafts: Draft[] = new Array(starts.length);
  for (const [commandIndex, indexes] of byCall) {
    const record = records[commandIndex];
    const outputs = attributeOutput(
      indexes.map((i) => starts[i]),
      outputOf(record)
    );
    indexes.forEach((startIndex, j) => {
      const output = outputs[j];
      drafts[startIndex] = {
        inv: starts[startIndex],
        output: output ?? '',
        attributed: output !== undefined,
        ownsRecordStatus: output !== undefined && j === indexes.length - 1,
        record,
      };
    });
  }

  const classified = drafts.map((draft) => ({
    draft,
    ...classify(draft.inv, draft.output),
  }));
  const outcomes = drafts.map(
    ({ attributed, ownsRecordStatus, output, record }) => {
      if (!attributed) return undefined;
      const fromOutput = startOutcome(withoutNotice(output));
      if (fromOutput !== undefined || !ownsRecordStatus) return fromOutput;
      return record?.error !== undefined
        ? false
        : record?.result !== undefined
          ? true
          : undefined;
    }
  );
  const lastReal = classified.reduce(
    (last, { requested }, i) => (requested === 'invalid' ? last : i),
    -1
  );
  const stackRuntime: ResolvedRuntime = stack.ok ? stack.runtime : 'unknown';

  const resolved: Array<ResolvedRuntime | undefined> = [];
  let carried: Exclude<ResolvedRuntime, 'unknown'> | undefined;
  for (const inv of invocations) {
    if (invocationVerb(inv) === 'stack destroy') carried = undefined;
    if (!isStartInvocation(inv)) continue;
    const i = resolved.length;
    const runtime = resolveFromEvidence(
      classified[i].requested,
      drafts[i],
      carried
    );
    resolved.push(runtime);
    if (
      outcomes[i] === true &&
      runtime !== undefined &&
      runtime !== 'unknown'
    ) {
      carried = runtime;
    }
  }
  for (let i = resolved.length - 1; i >= 0; i--) {
    if (resolved[i] !== undefined) continue;
    const nextAuto = classified.findIndex(
      ({ requested }, j) => j > i && requested === 'auto'
    );
    resolved[i] =
      nextAuto !== -1
        ? (resolved[nextAuto] ?? 'unknown')
        : i === lastReal
          ? stackRuntime
          : 'unknown';
  }

  return classified.map(({ draft, backend, requested }, i) => ({
    commandIndex: draft.inv.commandIndex,
    backend,
    requested,
    resolved: resolved[i] ?? 'unknown',
    ok: outcomes[i],
    runtimeMismatch: RUNTIME_MISMATCH_RE.test(draft.output),
  }));
}

export function formatAttempt(attempt: StartAttempt): string {
  return `${attempt.requested}→${attempt.resolved}`;
}

const isFailedDocker = (attempt: StartAttempt) =>
  attempt.resolved === 'docker' && attempt.ok === false;
const isNonDocker = (attempt: StartAttempt) =>
  attempt.resolved === 'native' || attempt.resolved === 'podman';

/** Tool calls from the first failed docker start through the first successful non-docker start, inclusive; null if either is missing. */
export function recoverySteps(
  timeline: readonly StartAttempt[]
): number | null {
  const failedAt = timeline.findIndex(isFailedDocker);
  if (failedAt === -1) return null;
  const recovered = timeline
    .slice(failedAt + 1)
    .find((attempt) => isNonDocker(attempt) && attempt.ok === true);
  return recovered === undefined
    ? null
    : recovered.commandIndex - timeline[failedAt].commandIndex + 1;
}

export type ProjectProbe =
  | { ok: true; dir: string; note?: string }
  | { ok: false; notes: string };

export async function locateProject(ctx: ExecContext): Promise<ProjectProbe> {
  const { all } = await findProjectDirs(ctx, []);
  const dirs = all.map((dir) => (dir === '' ? '.' : dir));
  if (dirs.length === 0) {
    return {
      ok: false,
      notes: 'no supabase/config.toml found under the workspace',
    };
  }
  const [dir] = [...dirs].sort(
    (a, b) => a.split('/').length - b.split('/').length
  );
  return {
    ok: true,
    dir,
    ...(dirs.length > 1
      ? {
          note: `multiple config.toml found (${dirs.join(', ')}); using shallowest: ${dir}`,
        }
      : {}),
  };
}

export function checkProjectInitialised(project: ProjectProbe): CheckResult {
  const name = 'supabase project initialised (supabase/config.toml exists)';
  return project.ok
    ? { name, passed: true, notes: project.note }
    : { name, passed: false, notes: project.notes };
}

export function checkDockerAttemptedFirst(
  timeline: readonly StartAttempt[]
): CheckResult {
  const name = 'docker runtime was attempted first';
  const first = timeline.find(({ requested }) => requested !== 'invalid');
  if (first === undefined) {
    return { name, passed: false, notes: 'no start attempted' };
  }
  if (first.resolved === 'docker') return { name, passed: true };
  return {
    name,
    passed: false,
    notes:
      first.resolved === 'unknown'
        ? `could not tell which runtime the first start (requested ${first.requested}) resolved to`
        : `silent fallback: first start resolved to ${first.resolved} (requested ${first.requested})`,
  };
}

export function checkRecovered(
  timeline: readonly StartAttempt[],
  actual: ActualRuntime
): CheckResult {
  const name = 'recovered via a non-docker runtime';
  if (actual === 'docker') {
    return {
      name,
      passed: true,
      notes: 'Docker reachable; no recovery needed',
    };
  }

  const firstDocker = timeline.findIndex(
    ({ resolved }) => resolved === 'docker'
  );
  const nonDockerAfterDocker =
    firstDocker === -1
      ? []
      : timeline.slice(firstDocker + 1).filter(isNonDocker);

  if (actual === 'native') {
    const passed = nonDockerAfterDocker.length > 0;
    return {
      name,
      passed,
      notes: passed
        ? undefined
        : 'native came up without a docker attempt followed by a non-docker one',
    };
  }

  const fail = (notes: string): CheckResult => ({ name, passed: false, notes });
  if (!timeline.some(({ backend }) => backend === 'managed')) {
    return fail('managed stack never reached: no managed start attempted');
  }
  if (firstDocker === -1) {
    return fail('no docker attempt on record; no recovery attempted');
  }
  if (nonDockerAfterDocker.length === 0) {
    return fail('docker attempted, no recovery attempted');
  }
  if (nonDockerAfterDocker.some(({ runtimeMismatch }) => runtimeMismatch)) {
    return fail('recovery blocked by runtime mismatch');
  }
  return fail('recovery attempted but no stack came up');
}

export function checkRecordedRuntimeMatches(
  stack: StackProbe,
  ready: boolean,
  actual: ActualRuntime
): CheckResult {
  const name = 'recorded runtime matches what started';
  if (!stack.ok || !ready) {
    return { name, passed: false, notes: 'no stack running' };
  }
  const passed = stack.runtime === actual;
  return {
    name,
    passed,
    notes: passed ? undefined : `recorded ${stack.runtime}, actually ${actual}`,
  };
}

/** What actually started: a ready stack with a postgres in the sandbox's /proc is native; any other ready stack ran on Docker. */
export async function probeActualRuntime(
  ctx: ExecContext,
  ready: boolean
): Promise<ActualRuntime> {
  if (!ready) return 'none';
  const inProc = await safely(() =>
    ctx.exec(
      'for p in /proc/[0-9]*/comm; do cat "$p"; done 2>/dev/null | grep -qx postgres'
    )
  );
  return inProc?.ok ? 'native' : 'docker';
}
