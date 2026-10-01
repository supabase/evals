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

export async function readCliVersion(ctx: ExecContext): Promise<string | null> {
  return safely(async () => {
    const result = await ctx.exec('supabase --version');
    return result.ok ? result.stdout.trim() : null;
  });
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
