import type { LocalStackEvalContext } from '@supabase-evals/core';
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

/** `runtime.kind` from a `parseJsonObject`-parsed stdout, defaulting to `'unknown'`. */
export function readRuntimeKind(stdout: string): StackRuntime {
  const runtime = parseJsonObject(stdout)?.runtime as
    | { kind?: unknown }
    | undefined;
  const kind = runtime?.kind;
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

type CascadeStep = {
  label: StackBackend;
  noteLabel?: string;
  envCommand: string;
  statusCommand?: string;
};

function cascadeSteps(target: StackTarget): CascadeStep[] {
  const steps: CascadeStep[] = [];
  const stackName = target.kind === 'root' ? undefined : target.stackName;
  const dir = target.kind === 'project' ? target.dir : undefined;
  if (stackName !== undefined) {
    const flag = `--stack ${shellQuote(stackName)}`;
    const envCommand = `SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status ${flag} --env --output-format json`;
    const statusCommand = `SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status ${flag} --output-format json`;
    // A managed stack's identity is (projectRoot, name), so a named stack
    // started inside the project dir is only visible from that dir.
    if (dir !== undefined) {
      steps.push({
        label: 'managed-named',
        noteLabel: 'managed-named (project dir)',
        envCommand: inProjectDir(dir, envCommand),
        statusCommand: inProjectDir(dir, statusCommand),
      });
    }
    steps.push({ label: 'managed-named', envCommand, statusCommand });
  }
  if (target.kind === 'named') return steps;

  steps.push(
    {
      label: 'managed',
      envCommand: inProjectDir(
        dir,
        'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --env --output-format json'
      ),
      statusCommand: inProjectDir(
        dir,
        'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --output-format json'
      ),
    },
    {
      label: 'legacy',
      envCommand: inProjectDir(
        dir,
        'SUPABASE_EXPERIMENTAL_STACK=0 supabase status -o json'
      ),
    }
  );
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

/**
 * Resolves which stack backend actually came up and the Postgres connection
 * string to reach it, trying a named managed stack (when a name is given;
 * from the project dir first, then the sandbox root), then the cwd-scoped
 * managed stack, then the legacy Docker Compose stack.
 * The first step that yields a `DB_URL` wins.
 */
export async function resolveStack(
  ctx: ExecContext,
  target: StackTarget = { kind: 'root' }
): Promise<StackProbe> {
  const steps = cascadeSteps(target);
  const details: string[] = [];
  for (const step of steps) {
    const outcome = await runStep(ctx, step);
    if ('ok' in outcome) return outcome;
    details.push(`${step.noteLabel ?? step.label}: ${outcome.detail}`);
  }
  return {
    ok: false,
    notes: truncate(
      details.join('; '),
      Math.max(MIN_NOTES_CHARS, NOTES_CHARS_PER_STEP * steps.length)
    ),
  };
}

/** One-line summary of a probe for judge ground truth. */
export function describeStack(stack: StackProbe): string {
  return stack.ok
    ? `resolved: ${stack.backend}/${stack.runtime}`
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
