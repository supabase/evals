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

/**
 * Names `supabase start` injects on its own. A function reading one of these is
 * not reading the credential this eval is about, so they never count as the one
 * that has to be placed.
 */
const PLATFORM_NAMES = /^(SUPABASE_|SB_|DENO_)/;

/** Files whose whole point is to be committed, so they are not a leak. */
const TEMPLATE_FILE = /\.(example|sample|template)$/;

const ENV_FILE = /(^|\/)\.env/;
const ENV_GET = /Deno\.env\.get\s*\(\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]/g;
const ENV_BROAD = /Deno\.env\.toObject\s*\(|process\.env\b/;

type EnvEntry = { file: string; name: string };

export type SecretChecks = {
  readsFromEnv: CheckResult;
  loadablePath: CheckResult;
  ignored: CheckResult;
};

export async function checkSecret(
  ctx: LocalStackEvalContext
): Promise<SecretChecks> {
  const root = ctx.hostWorkspace;
  const sources = functionSources(root);
  const wanted = credentialNames(sources);
  const defined = envAssignments(root);

  // The files that stand up the credential the function asks for. Tracking the
  // name rather than the seeded value is deliberate: an agent is free to
  // replace the placeholder the seed shipped, and the first baseline showed
  // they do. What has to be true is that whatever the function reads is set
  // somewhere the runtime loads, and that the file is not committed.
  const holders = defined.filter((entry) => wanted.names.has(entry.name));
  const carriers =
    holders.length > 0
      ? holders
      : wanted.broad
        ? defined.filter((entry) => !PLATFORM_NAMES.test(entry.name))
        : [];

  return {
    readsFromEnv: checkReadsFromEnv(root, sources),
    loadablePath: checkLoadablePath(ctx, carriers, wanted),
    ignored: await checkIgnored(ctx, carriers),
  };
}

function functionSources(root: string): string[] {
  const dir = join(root, 'supabase', 'functions');
  return walk(dir, dir).filter(
    (file) => /\.(ts|tsx|js|mjs)$/.test(file) && !ENV_FILE.test(file)
  );
}

/**
 * The non-platform env names the functions read. `broad` covers a function that
 * takes the whole environment at once, where there is no name to extract and
 * the check falls back to asking whether any credential is placed at all.
 */
function credentialNames(sources: string[]): {
  names: Set<string>;
  broad: boolean;
} {
  const names = new Set<string>();
  let broad = false;
  for (const file of sources) {
    const src = readText(file);
    if (ENV_BROAD.test(src)) broad = true;
    for (const match of src.matchAll(ENV_GET)) {
      if (!PLATFORM_NAMES.test(match[1])) names.add(match[1]);
    }
  }
  return { names, broad };
}

/** Every `NAME=value` with a value, across every env file in the workspace. */
function envAssignments(root: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  for (const file of walk(root, root)) {
    const rel = relative(root, file);
    if (!ENV_FILE.test(rel) || rel.startsWith('dist/')) continue;
    for (const line of readText(file).split('\n')) {
      const trimmed = line.trim().replace(/^export\s+/, '');
      if (!trimmed || trimmed.startsWith('#')) continue;
      const split = trimmed.indexOf('=');
      if (split <= 0) continue;
      const value = trimmed
        .slice(split + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (!value) continue;
      entries.push({ file: rel, name: trimmed.slice(0, split).trim() });
    }
  }
  return entries;
}

/**
 * A source-level claim, and named as one. It rules out the seeded literal being
 * pasted into the handler, and requires a function to read its configuration
 * from the environment at all. What the runtime hands the function is check
 * `the suggest endpoint has the provider key at request time`, which is the
 * behavioral counterpart.
 */
function checkReadsFromEnv(root: string, sources: string[]): CheckResult {
  const name = 'every function reads the provider key from the environment';

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
  if (literal.length > 0) {
    return {
      name,
      passed: false,
      notes: `provider key hardcoded in ${literal.join(', ')}`,
    };
  }

  const { names, broad } = credentialNames(sources);
  const reads = names.size > 0 || broad;
  return {
    name,
    passed: reads,
    notes: reads
      ? `reads ${names.size > 0 ? [...names].join(', ') : 'the whole environment'}`
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
  carriers: EnvEntry[],
  wanted: { names: Set<string>; broad: boolean }
): CheckResult {
  const name =
    'the provider key sits where the local function runtime loads it';

  if (carriers.length === 0) {
    const asked =
      wanted.names.size > 0
        ? `the function reads ${[...wanted.names].join(', ')}, and no env file sets ${wanted.names.size > 1 ? 'any of them' : 'it'}`
        : 'no function reads a credential from the environment, so nothing was placed';
    return { name, passed: false, notes: asked };
  }

  const referenced = envFileArguments(ctx);
  const loadable = [
    ...new Set(
      carriers
        .filter(
          (entry) => entry.file === AUTOLOADED || referenced.has(entry.file)
        )
        .map((entry) => entry.file)
    ),
  ];

  if (loadable.length === 0) {
    const where = [...new Set(carriers.map((entry) => entry.file))];
    return {
      name,
      passed: false,
      notes: `credential set only in ${where.join(', ')}, which ${AUTOLOADED} does not cover and no --env-file points at`,
    };
  }

  const stray = [
    ...new Set(
      carriers
        .map((entry) => entry.file)
        .filter((file) => !loadable.includes(file))
    ),
  ];
  return {
    name,
    passed: true,
    notes: stray.length
      ? `loaded from ${loadable.join(', ')}; also set in ${stray.join(', ')}`
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
 *
 * Template files are carved out. Shipping `.env.example` with a placeholder is
 * the documented habit, and failing a solution for doing it would be a false
 * red.
 */
async function checkIgnored(
  ctx: LocalStackEvalContext,
  carriers: EnvEntry[]
): Promise<CheckResult> {
  const name =
    "the file holding the provider key is covered by the project's ignore rules";

  const files = [
    ...new Set(
      carriers
        .map((entry) => entry.file)
        .filter((file) => !TEMPLATE_FILE.test(file))
    ),
  ];

  if (files.length === 0) {
    return {
      name,
      passed: false,
      notes:
        carriers.length > 0
          ? 'the credential is only in a template file, so nothing real was placed'
          : 'not run because no credential was placed in an env file',
    };
  }

  const quoted = files.map((file) => `'${file.replace(/'/g, "'\\''")}'`);
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
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    name,
    passed: tracked.length === 0,
    notes: tracked.length
      ? `would be committed: ${tracked.join(', ')}`
      : `ignored: ${files.join(', ')}`,
  };
}
