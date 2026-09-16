import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';

export type MigrationState = {
  pending: string[];
  applyFailed?: string;
};

export async function applyPendingMigrations(
  ctx: LocalStackEvalContext
): Promise<MigrationState> {
  const listed = await ctx.exec('supabase migration list --local', {
    timeoutMs: 120_000,
  });
  const pending = parsePending(listed.stdout ?? '');

  if (pending.length === 0) {
    return { pending };
  }

  const applied = await ctx.exec('supabase migration up --local', {
    timeoutMs: 300_000,
  });
  if (applied.exitCode !== 0) {
    return {
      pending,
      applyFailed: firstError(
        `${applied.stderr ?? ''}\n${applied.stdout ?? ''}`
      ),
    };
  }
  return { pending };
}

export function checkMigrationsWereApplied(state: MigrationState): CheckResult {
  return {
    name: 'the agent applied the migrations it wrote',
    passed: state.pending.length === 0,
    notes:
      state.pending.length === 0
        ? 'nothing pending'
        : state.applyFailed
          ? `pending: ${state.pending.join(', ')}; the scorer could not apply them: ${state.applyFailed}`
          : `pending: ${state.pending.join(', ')}; the scorer applied them so the rest of the checks could run`,
  };
}

function parsePending(stdout: string): string[] {
  const json = stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('{') && line.includes('"migrations"'));

  if (json) {
    try {
      const parsed = JSON.parse(json) as {
        migrations?: { local?: string; remote?: string }[];
      };
      return (parsed.migrations ?? [])
        .filter((entry) => entry.local && entry.local !== entry.remote)
        .map((entry) => String(entry.local));
    } catch {
      return [];
    }
  }

  const pending: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.includes('|')) continue;
    const [local, remote] = line.split('|').map((cell) => cell.trim());
    if (!local || !/^\d+$/.test(local)) continue;
    if (remote === local) continue;
    pending.push(local);
  }
  return pending;
}

function firstError(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const named = lines.find((line) =>
    /^(ERROR|FATAL|DETAIL|HINT)\b/i.test(line)
  );
  return (named ?? lines[0] ?? 'no output').slice(0, 300);
}
