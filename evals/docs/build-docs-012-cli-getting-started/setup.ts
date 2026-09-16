import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';

export type Manifest = {
  found: boolean;
  pinned?: string;
  field?: string;
  raw?: string;
};

export async function readManifest(
  ctx: LocalStackEvalContext
): Promise<Manifest> {
  let raw: string;
  try {
    raw = await ctx.readFile('package.json');
  } catch {
    return { found: false };
  }

  let parsed: Record<string, Record<string, string> | undefined>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { found: false, raw: raw.slice(0, 200) };
  }

  for (const field of ['devDependencies', 'dependencies']) {
    const entry = parsed[field]?.supabase;
    if (typeof entry === 'string') {
      return { found: true, pinned: entry, field };
    }
  }
  return { found: true };
}

export function checkProjectIsInitialized(initialized: boolean): CheckResult {
  return {
    name: 'the repository has a Supabase project in it',
    passed: initialized,
    notes: initialized ? undefined : 'no supabase/config.toml at the root',
  };
}

export function checkCliIsPinnedInTheProject(manifest: Manifest): CheckResult {
  return {
    name: 'the CLI is pinned in the project rather than only on the machine',
    passed: manifest.pinned !== undefined,
    notes: !manifest.found
      ? 'could not read package.json'
      : manifest.pinned !== undefined
        ? `${manifest.field}.supabase = ${manifest.pinned}`
        : 'package.json lists supabase in neither devDependencies nor dependencies',
  };
}

export async function checkCliRunsFromTheProject(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const result = await ctx.exec('./node_modules/.bin/supabase --version', {
    timeoutMs: 180_000,
  });
  const version = (result.stdout ?? '').trim().split('\n').pop() ?? '';
  const ran = result.exitCode === 0 && /^\d+\.\d+\.\d+/.test(version);

  return {
    name: "the repository's own copy of the CLI runs",
    passed: ran,
    notes: ran
      ? version
      : `./node_modules/.bin/supabase --version exited ${result.exitCode}: ${firstLine(result)}`,
  };
}

export async function checkCliIsInstalled(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const result = await ctx.exec('ls node_modules/.bin/supabase', {
    timeoutMs: 60_000,
  });

  return {
    name: 'the pinned CLI is installed in the repository',
    passed: result.exitCode === 0,
    notes:
      result.exitCode === 0
        ? 'node_modules/.bin/supabase'
        : 'nothing at node_modules/.bin/supabase, so a fresh clone would have to find the CLI elsewhere',
  };
}

function firstLine(result: { stdout?: string; stderr?: string }): string {
  const lines = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return (lines[0] ?? 'no output').slice(0, 200);
}
