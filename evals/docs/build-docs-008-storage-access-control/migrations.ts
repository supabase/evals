import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';

export type MigrationState = {
  pending: string[];
  applyFailed?: string;
};

export async function applyPendingMigrations(
  ctx: LocalStackEvalContext
): Promise<MigrationState> {
  const pending = await pendingVersions(ctx);

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

async function pendingVersions(ctx: LocalStackEvalContext): Promise<string[]> {
  const onDisk = migrationVersionsOnDisk(ctx.hostWorkspace);
  if (onDisk.length === 0) {
    return [];
  }

  const { rows: history } = await ctx.query(
    "SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS present;"
  );
  if (history[0]?.present !== true) {
    return onDisk;
  }

  const { rows } = await ctx.query(
    'SELECT version FROM supabase_migrations.schema_migrations;'
  );
  const applied = new Set(rows.map((row) => String(row.version)));
  return onDisk.filter((version) => !applied.has(version));
}

function migrationVersionsOnDisk(hostWorkspace: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(hostWorkspace, 'supabase', 'migrations'));
  } catch {
    return [];
  }
  return entries
    .map((entry) => /^(\d+)(?:_.*)?\.sql$/.exec(entry)?.[1])
    .filter((version): version is string => version !== undefined)
    .sort();
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
