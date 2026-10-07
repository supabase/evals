import type {
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;

/** `fn`'s result, or null if it throws — metrics never fail a run. */
export async function safely<T>(fn: () => Promise<T> | T): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

const STAGED_CLI_PATH = '/usr/bin/supabase';

export async function readCliVersion(
  ctx: ExecContext,
  binary = 'supabase'
): Promise<string | null> {
  return safely(async () => {
    const result = await ctx.exec(`${binary} --version`);
    return result.ok ? result.stdout.trim() : null;
  });
}

/** The staged CLI version: the marker's, else the release `.deb` binary's, else whatever `supabase` resolves to on PATH. */
export async function readStagedCliVersion(
  ctx: ExecContext,
  marker: LocalStackEnvironmentMarker | undefined
): Promise<string | null> {
  return (
    marker?.cliVersion ||
    (await readCliVersion(ctx, STAGED_CLI_PATH)) ||
    readCliVersion(ctx)
  );
}

/**
 * The staged CLI version, plus the PATH `supabase --version` when it differs —
 * an agent's global reinstall can shadow the staged binary on PATH.
 */
export async function readCliVersions(
  ctx: ExecContext,
  marker: LocalStackEnvironmentMarker | undefined
): Promise<{ cliVersion: string | null; cliVersionAfterRun?: string }> {
  const staged = await readStagedCliVersion(ctx, marker);
  const afterRun = await readCliVersion(ctx);
  const normalise = (version: string | null) =>
    version?.trim().replace(/^v/, '') ?? null;
  return {
    cliVersion: staged,
    ...(afterRun !== null && normalise(afterRun) !== normalise(staged)
      ? { cliVersionAfterRun: afterRun }
      : {}),
  };
}

/** Agent session start in epoch milliseconds, from the marker or the sandbox's PID 1. */
export async function readSessionStartMs(
  ctx: ExecContext,
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

/** Count of commands that unset or blank `DOCKER_HOST`. */
export function countClearedDockerHost(commands: readonly string[]): number {
  return commands.filter((command) =>
    /\bunset\s+DOCKER_HOST\b|\bDOCKER_HOST=(?=\s|$)/i.test(command)
  ).length;
}
