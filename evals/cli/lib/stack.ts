import type { LocalStackEvalContext } from '@supabase-evals/core';
import {
  invocationTargetUnresolved,
  invocationTargets,
  invocationVerb,
  type InvocationEnv,
  type SupabaseInvocation,
} from './cli-invocations.js';
import {
  describeFailure,
  errorMessage,
  inProjectDir,
  shellQuote,
  truncate,
} from './shell.js';

export type StackRuntime = 'native' | 'docker' | 'unknown';
export type StackBackend = 'managed-named' | 'managed' | 'legacy';
export type ResolvedStack = {
  ok: true;
  backend: StackBackend;
  dbUrl: string;
  apiUrl?: string;
  runtime: StackRuntime;
  /** The CLI state root the stack was found under, set only when it is not the default home. */
  relocatedHome?: string;
};
export type StackProbe = ResolvedStack | { ok: false; notes: string };
export type StackTarget =
  | { kind: 'root' }
  | { kind: 'project'; dir: string; stackName?: string }
  | { kind: 'named'; stackName: string };

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;

/**
 * Pulls the first `{…}` JSON object out of a CLI command's stdout. Tries, in
 * order: the whole trimmed stdout; each line that looks like a standalone
 * object; then every `{…}` substring (longest first) — so `[task]` progress
 * lines the CLI's managed-stack commands interleave around the JSON payload
 * don't defeat a plain `JSON.parse`.
 */
export function parseJsonObject(
  stdout: string
): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;

  const candidates: string[] = [trimmed];
  for (const line of trimmed.split('\n')) {
    const candidate = line.trim();
    if (candidate.startsWith('{') && candidate.endsWith('}')) {
      candidates.push(candidate);
    }
  }

  const opens: number[] = [];
  const closes: number[] = [];
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '{') opens.push(i);
    if (trimmed[i] === '}') closes.push(i);
  }
  const substrings: Array<{ start: number; end: number }> = [];
  for (const start of opens) {
    for (const end of closes) {
      if (end > start) substrings.push({ start, end });
    }
  }
  substrings.sort((a, b) => b.end - b.start - (a.end - a.start));
  candidates.push(
    ...substrings.map(({ start, end }) => trimmed.slice(start, end + 1))
  );

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

/** `DB_URL` from a `parseJsonObject`-parsed stdout, when present and non-empty. */
export function readDbUrl(stdout: string): string | undefined {
  const dbUrl = parseJsonObject(stdout)?.DB_URL;
  return typeof dbUrl === 'string' && dbUrl.length > 0 ? dbUrl : undefined;
}

/** `API_URL` from a `parseJsonObject`-parsed stdout, when present and non-empty. */
export function readApiUrl(stdout: string): string | undefined {
  const apiUrl = parseJsonObject(stdout)?.API_URL;
  return typeof apiUrl === 'string' && apiUrl.length > 0 ? apiUrl : undefined;
}

/** `runtime` (a string, or `{ kind }`) from a `parseJsonObject`-parsed stdout, defaulting to `'unknown'`. */
export function readRuntimeKind(stdout: string): StackRuntime {
  const runtime = parseJsonObject(stdout)?.runtime;
  const kind =
    typeof runtime === 'object' && runtime !== null
      ? (runtime as { kind?: unknown }).kind
      : runtime;
  return kind === 'native' || kind === 'docker' ? kind : 'unknown';
}

/** Numeric port from a URL string, or undefined if it can't be parsed / has none. */
export function urlPort(rawUrl: string): number | undefined {
  try {
    const port = Number(new URL(rawUrl).port);
    return Number.isFinite(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

/** `rawUrl` with any userinfo (user:password@) stripped — for putting a DB/API url in notes without leaking credentials. */
export function maskUrlCredentials(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return '<unparseable-url>';
  }
}

// Root failure notes keep a 300-char total; each extra cascade step adds 150.
const NOTES_CHARS_PER_STEP = 150;
const MIN_NOTES_CHARS = 300;
const MAX_NOTES_CHARS = 900;

type CascadeStep = {
  label: StackBackend;
  noteLabel?: string;
  envCommand: string;
  statusCommand?: string;
};

const HOME_VARIABLES = ['SUPABASE_HOME', 'HOME', 'TMPDIR'] as const;

function homePrefix(home: InvocationEnv | undefined): string {
  return HOME_VARIABLES.flatMap((name) => {
    const value = home?.[name];
    return value === undefined ? [] : [`${name}=${shellQuote(value)} `];
  }).join('');
}

function homeLabel(home: InvocationEnv): string {
  return home.SUPABASE_HOME !== undefined
    ? `SUPABASE_HOME=${home.SUPABASE_HOME}`
    : `HOME=${home.HOME}`;
}

/** The directory the CLI keeps its managed stack registry under for `home`. */
function effectiveRoot(home: InvocationEnv): string | undefined {
  if (home.SUPABASE_HOME !== undefined) return home.SUPABASE_HOME;
  return home.HOME === undefined ? undefined : `${home.HOME}/.supabase`;
}

function namedStepCommands(
  stackName: string,
  prefix: string
): {
  envCommand: string;
  statusCommand: string;
} {
  const flag = `--stack ${shellQuote(stackName)}`;
  return {
    envCommand: `${prefix}SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status ${flag} --env --output-format json`,
    statusCommand: `${prefix}SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status ${flag} --output-format json`,
  };
}

// A managed stack's identity is (projectRoot, name), so a named stack started
// inside the project dir is only visible from that dir.
function projectNamedStep(
  dir: string,
  stackName: string,
  prefix: string
): CascadeStep {
  const { envCommand, statusCommand } = namedStepCommands(stackName, prefix);
  return {
    label: 'managed-named',
    noteLabel: 'managed-named (project dir)',
    envCommand: inProjectDir(dir, envCommand),
    statusCommand: inProjectDir(dir, statusCommand),
  };
}

function cascadeSteps(
  target: StackTarget,
  home?: InvocationEnv
): CascadeStep[] {
  const prefix = homePrefix(home);
  const steps: CascadeStep[] = [];
  const stackName = target.kind === 'root' ? undefined : target.stackName;
  const dir = target.kind === 'project' ? target.dir : undefined;
  if (stackName !== undefined) {
    if (dir !== undefined) steps.push(projectNamedStep(dir, stackName, prefix));
    steps.push({
      label: 'managed-named',
      ...namedStepCommands(stackName, prefix),
    });
  }
  if (target.kind === 'named') return steps;

  steps.push({
    label: 'managed',
    envCommand: inProjectDir(
      dir,
      `${prefix}SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --env --output-format json`
    ),
    statusCommand: inProjectDir(
      dir,
      `${prefix}SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --output-format json`
    ),
  });
  if (home === undefined) {
    steps.push({
      label: 'legacy',
      envCommand: inProjectDir(
        dir,
        'SUPABASE_EXPERIMENTAL_STACK=0 supabase status -o json'
      ),
    });
  }
  return steps;
}

async function runStep(
  ctx: ExecContext,
  step: CascadeStep
): Promise<ResolvedStack | { detail: string }> {
  try {
    const envResult = await ctx.exec(step.envCommand);
    const dbUrl = readDbUrl(envResult.stdout);
    if (!dbUrl) return { detail: describeFailure(envResult) };
    const apiUrl = readApiUrl(envResult.stdout);
    if (step.statusCommand === undefined) {
      return {
        ok: true,
        backend: step.label,
        dbUrl,
        apiUrl,
        runtime: 'docker',
      };
    }
    let runtime: StackRuntime = 'unknown';
    try {
      const statusResult = await ctx.exec(step.statusCommand);
      runtime = readRuntimeKind(statusResult.stdout);
    } catch {
      // runtime stays 'unknown' — DB_URL already resolved the backend.
    }
    return { ok: true, backend: step.label, dbUrl, apiUrl, runtime };
  } catch (error) {
    return { detail: errorMessage(error) };
  }
}

type NamedStackDiscovery = { names: string[] } | { detail: string };

/**
 * Names of the non-default managed stacks whose `project_root` is `dir`,
 * reachable owners first. `stack list` is global, so sibling projects' stacks
 * are filtered out by resolved path.
 */
async function discoverNamedStacks(
  ctx: ExecContext,
  dir: string,
  prefix: string
): Promise<NamedStackDiscovery> {
  try {
    const result = await ctx.exec(
      inProjectDir(
        dir,
        `pwd -P && ${prefix}SUPABASE_EXPERIMENTAL_STACK=1 supabase stack list --output-format json`
      )
    );
    const [firstLine = '', ...rest] = result.stdout.split('\n');
    const projectRoot = firstLine.trim();
    const stacks = parseJsonObject(rest.join('\n'))?.stacks;
    if (!projectRoot || !Array.isArray(stacks)) {
      return {
        detail: result.ok ? 'unparseable output' : describeFailure(result),
      };
    }
    const entries = stacks.filter(
      (entry): entry is { name: string; owner?: unknown } =>
        typeof entry === 'object' &&
        entry !== null &&
        entry.project_root === projectRoot &&
        typeof entry.name === 'string' &&
        entry.name !== 'default'
    );
    const reachable = (entry: { owner?: unknown }) =>
      entry.owner === 'reachable' ? 0 : 1;
    entries.sort((a, b) => reachable(a) - reachable(b));
    return { names: entries.map((entry) => entry.name) };
  } catch (error) {
    return { detail: errorMessage(error) };
  }
}

export type ResolveStackOptions = {
  /** Runs the managed commands under this CLI home and skips the home-independent legacy step. */
  home?: InvocationEnv;
};

/**
 * Resolves which stack backend actually came up and the Postgres connection
 * string to reach it, trying a named managed stack (when a name is given;
 * from the project dir first, then the sandbox root), then the cwd-scoped
 * managed stack, then — for a project dir without a name — each named managed
 * stack `stack list` reports for that dir, then the legacy Docker Compose
 * stack. The first step that yields a `DB_URL` wins.
 */
export async function resolveStack(
  ctx: ExecContext,
  target: StackTarget = { kind: 'root' },
  options: ResolveStackOptions = {}
): Promise<StackProbe> {
  const { home } = options;
  const prefix = homePrefix(home);
  const suffix = home === undefined ? '' : ` (${homeLabel(home)})`;
  const steps = cascadeSteps(target, home);
  const discoverIn =
    target.kind === 'project' && target.stackName === undefined
      ? target.dir
      : undefined;
  const details: string[] = [];
  let attempts = steps.length;
  const discover = async (dir: string): Promise<ResolvedStack | undefined> => {
    attempts += 1;
    const discovery = await discoverNamedStacks(ctx, dir, prefix);
    if ('detail' in discovery) {
      details.push(`stack list${suffix}: ${discovery.detail}`);
    } else if (discovery.names.length === 0) {
      details.push(`stack list${suffix}: no named stacks for this project`);
    }
    for (const name of 'names' in discovery ? discovery.names : []) {
      attempts += 1;
      const named = projectNamedStep(dir, name, prefix);
      const outcome = await runStep(ctx, named);
      if ('ok' in outcome) return outcome;
      details.push(`${named.noteLabel}${suffix} '${name}': ${outcome.detail}`);
    }
    return undefined;
  };
  for (const step of steps) {
    if (step.label === 'legacy' && discoverIn !== undefined) {
      const found = await discover(discoverIn);
      if (found) return found;
    }
    const outcome = await runStep(ctx, step);
    if ('ok' in outcome) return outcome;
    details.push(`${step.noteLabel ?? step.label}${suffix}: ${outcome.detail}`);
  }
  if (home !== undefined && discoverIn !== undefined) {
    const found = await discover(discoverIn);
    if (found) return found;
  }
  return {
    ok: false,
    notes: truncate(
      details.join('; '),
      Math.min(
        MAX_NOTES_CHARS,
        Math.max(MIN_NOTES_CHARS, NOTES_CHARS_PER_STEP * attempts)
      )
    ),
  };
}

const START_VERBS = new Set(['start', 'stack start']);

function targetName(target: StackTarget): string | undefined {
  if (target.kind === 'root') return undefined;
  if (target.kind === 'named') return target.stackName;
  return target.stackName ?? target.dir.slice(target.dir.lastIndexOf('/') + 1);
}

/**
 * Distinct relocated CLI homes the agent started the target under, newest
 * first. A home counts only when the invocation set `SUPABASE_HOME` or `HOME`.
 */
export function candidateHomes(
  invocations: readonly SupabaseInvocation[],
  target: StackTarget
): InvocationEnv[] {
  const name = targetName(target);
  const homes = new Map<string, InvocationEnv>();
  for (const inv of [...invocations].reverse()) {
    const { env } = inv;
    if (
      env === undefined ||
      effectiveRoot(env) === undefined ||
      !START_VERBS.has(invocationVerb(inv) ?? '') ||
      (name !== undefined &&
        !invocationTargets(inv, name) &&
        !invocationTargetUnresolved(inv))
    ) {
      continue;
    }
    homes.set(JSON.stringify(env), env);
  }
  return [...homes.values()];
}

/**
 * `resolveStack` under the default home first; only when that fails, retries
 * under each home the agent started the target with. A hit carries the
 * `relocatedHome` it was found under.
 */
export async function resolveStackWithAgentHomes(
  ctx: ExecContext,
  target: StackTarget,
  invocations: readonly SupabaseInvocation[]
): Promise<StackProbe> {
  const initial = await resolveStack(ctx, target);
  if (initial.ok) return initial;
  const notes = [initial.notes];
  for (const home of candidateHomes(invocations, target)) {
    const retry = await resolveStack(ctx, target, { home });
    if (retry.ok) {
      return { ...retry, relocatedHome: effectiveRoot(home) };
    }
    notes.push(retry.notes);
  }
  return notes.length === 1
    ? initial
    : { ok: false, notes: truncate(notes.join('; '), MAX_NOTES_CHARS) };
}

/** One-line summary of a probe for judge ground truth. */
export function describeStack(stack: StackProbe): string {
  return stack.ok
    ? `resolved: ${stack.backend}/${stack.runtime}${
        stack.relocatedHome === undefined
          ? ''
          : ` under the agent's relocated CLI home ${stack.relocatedHome}`
      }`
    : `none (${stack.notes})`;
}

export async function probeStackReady(
  ctx: ExecContext,
  stack: StackProbe
): Promise<{ ready: boolean; notes: string }> {
  if (!stack.ok) return { ready: false, notes: stack.notes };
  try {
    const result = await ctx.exec(
      `psql ${shellQuote(stack.dbUrl)} -tAc 'select 1'`
    );
    const ready = result.ok && result.stdout.trim() === '1';
    return {
      ready,
      notes: ready
        ? `${stack.backend} (${stack.runtime}), select 1 ok`
        : describeFailure(result),
    };
  } catch (error) {
    return { ready: false, notes: errorMessage(error) };
  }
}

/** Postgres postmaster start time in epoch milliseconds, or null. */
export async function readPostmasterStartMs(
  ctx: ExecContext,
  dbUrl: string
): Promise<number | null> {
  try {
    const result = await ctx.exec(
      `psql ${shellQuote(dbUrl)} -tAc 'select (extract(epoch from pg_postmaster_start_time()) * 1000)::bigint'`
    );
    if (!result.ok) return null;
    const value = Number(result.stdout.trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}
