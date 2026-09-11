import { join, relative } from 'node:path';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';

import { readText, walk } from './files.js';
import { PROVIDER_KEY } from './fixture.js';

/**
 * The path `supabase start` and `supabase functions serve` both read with no
 * arguments. In CLI 2.67.1 `parseEnvFile("")` falls back to it, and the values
 * become the edge runtime container's environment.
 */
const AUTOLOADED = 'supabase/functions/.env';

/** Where a `--env-file` argument could be written down and still be run. */
const SCRIPT_FILES = /^(package\.json|Makefile|justfile|.*\.sh)$/;

const ENV_READ =
  /Deno\.env\.(get|toObject)\s*\(|process\.env\b|from\s*['"](?:npm:|jsr:)?@?std\/dotenv/;

export type SecretChecks = {
  readsFromEnv: CheckResult;
  loadablePath: CheckResult;
  ignored: CheckResult;
};

export async function checkSecret(
  ctx: LocalStackEvalContext
): Promise<SecretChecks> {
  const root = ctx.hostWorkspace;
  const holders = walk(root, root)
    .map((file) => relative(root, file))
    .filter(
      (rel) =>
        !rel.startsWith('dist/') &&
        readText(join(root, rel)).includes(PROVIDER_KEY)
    );

  return {
    readsFromEnv: checkReadsFromEnv(root),
    loadablePath: checkLoadablePath(ctx, holders),
    ignored: await checkIgnored(ctx, holders),
  };
}

/**
 * A source-level claim, and named as one. It rules out the literal being
 * pasted into the handler, and requires at least one function to read its
 * configuration from the environment at all. What the runtime hands the
 * function is check `the suggest endpoint has the provider key at request
 * time`, which is the behavioral counterpart.
 */
function checkReadsFromEnv(root: string): CheckResult {
  const name = 'every function reads the provider key from the environment';
  const dir = join(root, 'supabase', 'functions');
  const sources = walk(dir, dir).filter(
    (file) => /\.(ts|tsx|js|mjs)$/.test(file) && !/(^|\/)\.env/.test(file)
  );

  if (sources.length === 0) {
    return {
      name,
      passed: false,
      notes: 'no function source under supabase/functions/',
    };
  }

  // Every source file, not the first. One clean handler beside one that
  // hardcodes the key is still a leak.
  const literal = sources
    .filter((file) => readText(file).includes(PROVIDER_KEY))
    .map((file) => relative(root, file));
  const readsEnv = sources.some((file) => ENV_READ.test(readText(file)));

  if (literal.length > 0) {
    return {
      name,
      passed: false,
      notes: `provider key hardcoded in ${literal.join(', ')}`,
    };
  }
  return {
    name,
    passed: readsEnv,
    notes: readsEnv
      ? undefined
      : 'no function reads its configuration from the environment',
  };
}

/**
 * A whitelist of the places the local runtime will load, rather than a
 * blocklist of the places it will not. The default path needs no argument. A
 * custom path counts when something that gets run points `--env-file` at it,
 * which is the other route the guide documents.
 */
function checkLoadablePath(
  ctx: LocalStackEvalContext,
  holders: string[]
): CheckResult {
  const name =
    'the provider key sits where the local function runtime loads it';

  if (holders.length === 0) {
    return {
      name,
      passed: false,
      notes: 'the seeded provider key is not in any file in the workspace',
    };
  }

  const referenced = envFileArguments(ctx);
  const loadable = holders.filter(
    (rel) => rel === AUTOLOADED || referenced.has(rel)
  );

  if (loadable.length === 0) {
    return {
      name,
      passed: false,
      notes: `provider key only in ${holders.join(', ')}, which ${AUTOLOADED} does not cover and no --env-file points at`,
    };
  }

  const stray = holders.filter((rel) => !loadable.includes(rel));
  return {
    name,
    passed: true,
    notes: stray.length
      ? `loaded from ${loadable.join(', ')}; also left in ${stray.join(', ')}`
      : `loaded from ${loadable.join(', ')}`,
  };
}

/** Paths a `--env-file` argument names, from committed scripts and from the agent's own commands. */
function envFileArguments(ctx: LocalStackEvalContext): Set<string> {
  const root = ctx.hostWorkspace;
  const haystack = [
    ...walk(root, root)
      .filter((file) => SCRIPT_FILES.test(relative(root, file)))
      .map(readText),
    ...ctx.toolCalls.map((call) => call.command ?? ''),
  ].join('\n');

  const paths = new Set<string>();
  for (const match of haystack.matchAll(
    /--env-file[=\s]+["']?([^\s"';|&]+)/g
  )) {
    paths.add(match[1].replace(/^\.\//, ''));
  }
  return paths;
}

/**
 * `git check-ignore` rather than `git ls-files`. The harness strips `.git` when
 * it copies the seed in, so a tracked-file scan matches nothing and reads green
 * whatever the project ignores.
 */
async function checkIgnored(
  ctx: LocalStackEvalContext,
  holders: string[]
): Promise<CheckResult> {
  const name =
    "the file holding the provider key is covered by the project's ignore rules";

  if (holders.length === 0) {
    return {
      name,
      passed: false,
      notes: 'not run because the seeded provider key is not in any file',
    };
  }

  const quoted = holders.map((rel) => `'${rel.replace(/'/g, "'\\''")}'`);
  const result = await ctx.exec(
    [
      'git rev-parse --git-dir >/dev/null 2>&1 || git init -q',
      `for f in ${quoted.join(' ')}; do`,
      '  git check-ignore -q "$f" || echo "$f"',
      'done',
    ].join('\n')
  );

  if (!result.ok) {
    return {
      name,
      passed: false,
      notes: `could not read ignore rules: ${(result.stderr || result.stdout).trim().slice(0, 500)}`,
    };
  }

  const tracked = result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    name,
    passed: tracked.length === 0,
    notes: tracked.length
      ? `would be committed: ${tracked.join(', ')}`
      : `ignored: ${holders.join(', ')}`,
  };
}
