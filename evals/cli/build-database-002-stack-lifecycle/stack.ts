import type {
  CheckResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { countRawDockerSocketProbes } from './detours.js';

const MIN_SEEDED_NOTES = 2;

export function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Scoring setup state is normally off-limits, but this scenario sets
// projectRunning: false — initialising the project is part of the agent's
// task, so config.toml existing is agent-produced state.
export async function checkProjectInitialised(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'supabase project initialised (supabase/config.toml exists)';
  try {
    const exists = await ctx.fileExists('supabase/config.toml');
    return { name, passed: exists };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}

export type StackProbe =
  | {
      ok: true;
      backend: 'managed' | 'legacy';
      dbUrl: string;
      runtime: 'native' | 'docker' | 'unknown';
    }
  | { ok: false; notes: string };

type ResolvedStack = Extract<StackProbe, { ok: true }>;

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

/** `runtime.kind` from a `parseJsonObject`-parsed stdout, defaulting to `'unknown'`. */
export function readRuntimeKind(
  stdout: string
): 'native' | 'docker' | 'unknown' {
  const runtime = parseJsonObject(stdout)?.runtime as
    | { kind?: unknown }
    | undefined;
  const kind = runtime?.kind;
  return kind === 'native' || kind === 'docker' ? kind : 'unknown';
}

export function describeFailure(result: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): string {
  const detail = (result.stderr || result.stdout).trim();
  return detail
    ? `exit ${result.exitCode ?? 'null'}: ${truncate(detail, 200)}`
    : `exit ${result.exitCode ?? 'null'}`;
}

/**
 * Resolves which stack backend actually came up (the managed stack the
 * agent's `supabase start` prefers, or the legacy Docker Compose stack) and
 * the Postgres connection string to reach it — so readiness and row checks
 * work against whichever backend the CLI under test resolved to, not a
 * hardcoded legacy port.
 */
export async function resolveStack(
  ctx: LocalStackEvalContext
): Promise<StackProbe> {
  let managedDetail: string;
  try {
    const envResult = await ctx.exec(
      'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --env --output-format json'
    );
    const dbUrl = readDbUrl(envResult.stdout);
    if (dbUrl) {
      let runtime: 'native' | 'docker' | 'unknown' = 'unknown';
      try {
        const statusResult = await ctx.exec(
          'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --output-format json'
        );
        runtime = readRuntimeKind(statusResult.stdout);
      } catch {
        // runtime stays 'unknown' — DB_URL already resolved the backend.
      }
      return { ok: true, backend: 'managed', dbUrl, runtime };
    }
    managedDetail = describeFailure(envResult);
  } catch (error) {
    managedDetail = error instanceof Error ? error.message : String(error);
  }

  let legacyDetail: string;
  try {
    const legacy = await ctx.exec(
      'SUPABASE_EXPERIMENTAL_STACK=0 supabase status -o json'
    );
    const dbUrl = readDbUrl(legacy.stdout);
    if (dbUrl) {
      return { ok: true, backend: 'legacy', dbUrl, runtime: 'docker' };
    }
    legacyDetail = describeFailure(legacy);
  } catch (error) {
    legacyDetail = error instanceof Error ? error.message : String(error);
  }

  return {
    ok: false,
    notes: truncate(`managed: ${managedDetail}; legacy: ${legacyDetail}`, 300),
  };
}

export async function checkStackReady(
  ctx: LocalStackEvalContext,
  stack: StackProbe
): Promise<CheckResult> {
  const name = 'local stack reaches ready';
  if (!stack.ok) return { name, passed: false, notes: stack.notes };
  try {
    const result = await ctx.exec(
      `psql ${shellQuote(stack.dbUrl)} -tAc 'select 1'`
    );
    const ready = result.ok && result.stdout.trim() === '1';
    return {
      name,
      passed: ready,
      notes: ready
        ? `probe: ${stack.backend} (${stack.runtime}), select 1 ok`
        : describeFailure(result),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}

export async function countNotesRows(
  ctx: LocalStackEvalContext,
  stack: ResolvedStack
): Promise<number | undefined> {
  try {
    const result = await ctx.exec(
      `psql ${shellQuote(stack.dbUrl)} -tAc 'select count(*) from public.notes'`
    );
    if (!result.ok) return undefined;
    const count = Number(result.stdout.trim());
    return Number.isFinite(count) ? count : undefined;
  } catch {
    return undefined;
  }
}

export function checkNotesSeeded(
  stack: StackProbe,
  rowCount: number | undefined
): CheckResult {
  const name = `notes table has at least ${MIN_SEEDED_NOTES} rows`;
  if (!stack.ok) return { name, passed: false, notes: stack.notes };
  if (rowCount === undefined) {
    return { name, passed: false, notes: 'could not read notes row count' };
  }
  return {
    name,
    passed: rowCount >= MIN_SEEDED_NOTES,
    notes: `found ${rowCount} rows`,
  };
}

async function safely<T>(fn: () => Promise<T> | T): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

export async function checkMetrics(
  ctx: LocalStackEvalContext,
  marker: LocalStackEnvironmentMarker | undefined,
  cliDetourCommands: readonly string[],
  commands: readonly string[],
  stack: StackProbe
): Promise<CheckResult> {
  const name = 'metrics';

  const cliVersion = await safely(async () => {
    const result = await ctx.exec('supabase --version');
    return result.ok ? result.stdout.trim() : null;
  });

  const resolvedRuntime = stack.ok ? stack.runtime : 'none';

  const readyMs = await safely(() =>
    stack.ok ? readReadyMs(ctx, stack.dbUrl) : Promise.resolve(null)
  );
  const startMs = await safely(() => readStartMs(ctx, marker));
  const timeToReadyMs =
    readyMs !== null && startMs !== null ? readyMs - startMs : null;

  const clearedDockerHost = await safely(
    () =>
      commands.filter((command) =>
        /\bunset\s+DOCKER_HOST\b|\bDOCKER_HOST=(?=\s|$)/i.test(command)
      ).length
  );

  const rawDockerSocketProbes = await safely(() =>
    countRawDockerSocketProbes(commands)
  );

  const metrics = {
    cliVersion,
    resolvedRuntime,
    timeToReadyMs,
    // Regex-based diagnostic — can disagree with `no container-runtime
    // detours` (a judge), and is never asserted against.
    cliDetours: cliDetourCommands.length,
    clearedDockerHost,
    rawDockerSocketProbes,
    channel: marker?.channel ?? 'pinned',
  };

  return { name, passed: true, notes: JSON.stringify(metrics) };
}

async function readReadyMs(
  ctx: LocalStackEvalContext,
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

async function readStartMs(
  ctx: LocalStackEvalContext,
  marker: LocalStackEnvironmentMarker | undefined
): Promise<number | null> {
  if (marker?.sessionStartedMs !== undefined) return marker.sessionStartedMs;
  try {
    // No marker means a stock pinned run: fall back to the sandbox's own PID 1
    // start time (/proc/1/stat's starttime, in clock ticks since boot, plus
    // /proc/stat's boot time), converted to epoch milliseconds.
    const result = await ctx.exec(
      "echo $(( ($(awk '{print $22}' /proc/1/stat) / $(getconf CLK_TCK) + $(awk '/^btime/ {print $2}' /proc/stat)) * 1000 ))"
    );
    if (!result.ok) return null;
    const value = Number(result.stdout.trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}
