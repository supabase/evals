import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { parse } from 'smol-toml';

export type Declared = {
  declared: string[];
  missing: string[];
  seedFailed?: string;
};

// Buckets declared in `[storage.buckets.<name>]` only exist once the CLI
// seeds them, and a stack that is already running won't. The scorer seeds
// them so one missed step costs one check rather than all of them, the same
// trade the migrations check makes.
export async function seedDeclaredBuckets(
  ctx: LocalStackEvalContext
): Promise<Declared> {
  try {
    const declared = declaredBuckets(ctx.hostWorkspace);
    if (declared.length === 0) return { declared, missing: [] };
    const missing = await missingFrom(ctx, declared);
    if (missing.length === 0) return { declared, missing };
    const seeded = await ctx.exec('supabase seed buckets --local 2>&1', {
      timeoutMs: 180_000,
    });
    return seeded.exitCode === 0
      ? { declared, missing }
      : { declared, missing, seedFailed: lastLine(seeded.stdout ?? '') };
  } catch (error) {
    return {
      declared: [],
      missing: [],
      seedFailed: (error instanceof Error
        ? error.message
        : String(error)
      ).slice(0, 300),
    };
  }
}

export function checkDeclaredBucketsExist(state: Declared): CheckResult {
  const name = 'the buckets declared in config.toml exist';
  if (state.declared.length === 0) {
    return {
      name,
      passed: !state.seedFailed,
      notes: state.seedFailed
        ? `could not check: ${state.seedFailed}`
        : 'none declared, so nothing to check',
    };
  }
  return {
    name,
    passed: state.missing.length === 0,
    notes:
      state.missing.length === 0
        ? `declared and present: ${state.declared.join(', ')}`
        : `declared but not created: ${state.missing.join(', ')}; ${
            state.seedFailed
              ? `the scorer could not seed them: ${state.seedFailed}`
              : 'the scorer seeded them so the rest of the checks could run'
          }`,
  };
}

function declaredBuckets(hostWorkspace: string): string[] {
  let text: string;
  try {
    text = readFileSync(join(hostWorkspace, 'supabase', 'config.toml'), 'utf8');
  } catch {
    return [];
  }
  const storage = parse(text).storage as
    | { buckets?: Record<string, unknown> }
    | undefined;
  return Object.keys(storage?.buckets ?? {});
}

async function missingFrom(
  ctx: LocalStackEvalContext,
  declared: string[]
): Promise<string[]> {
  const { rows } = await ctx.query('select id from storage.buckets;');
  const present = new Set(rows.map((row) => String(row.id)));
  return declared.filter((id) => !present.has(id));
}

function lastLine(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.find((line) => /error|failed/i.test(line)) ??
    lines.at(-1) ??
    'no output'
  ).slice(0, 300);
}
