import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type {
  CheckResult,
  LocalStackEvalContext,
  LocalStackStatus,
} from '@supabase-evals/core';

/** Directories that are never the agent's work. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.supabase',
  'supabase/.temp',
]);

const SECRET_KEY_PREFIX = /sb_secret_[A-Za-z0-9_-]+/;
const JWT = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/**
 * Every way a secret credential can show up, rather than a list of variable
 * names. A name list is incomplete the moment someone picks a new one.
 */
export function findSecrets(text: string, status: LocalStackStatus): string[] {
  const hits: string[] = [];

  if (SECRET_KEY_PREFIX.test(text)) hits.push('sb_secret_ key');
  if (status.secretKey && text.includes(status.secretKey)) {
    hits.push("the stack's secret key");
  }

  // Decode rather than match a literal, so any service_role JWT is caught and
  // not only the one this stack happens to be running.
  for (const token of text.match(JWT) ?? []) {
    if (roleOf(token) === 'service_role') {
      hits.push('a service_role JWT');
      break;
    }
  }

  return [...new Set(hits)];
}

function roleOf(jwt: string): string | undefined {
  try {
    const payload = jwt.split('.')[1];
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const role = (JSON.parse(json) as { role?: unknown }).role;
    return typeof role === 'string' ? role : undefined;
  } catch {
    return undefined;
  }
}

function walk(dir: string, root: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const rel = relative(root, full);
    if (SKIP_DIRS.has(entry) || SKIP_DIRS.has(rel)) continue;
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      out = out.concat(walk(full, root));
    } else if (info.size < 5_000_000) {
      out.push(full);
    }
  }
  return out;
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

export async function checkBundle(
  ctx: LocalStackEvalContext,
  status: LocalStackStatus
): Promise<CheckResult[]> {
  const build = await ctx.runViteBuild();
  const buildCheck: CheckResult = {
    name: 'vite build passed',
    passed: build.ok,
    notes: build.ok
      ? undefined
      : (build.stderr || build.stdout).trim().slice(0, 4000),
  };

  if (!build.ok) {
    // Not a pass. A missing bundle is the absence of evidence, and reporting
    // these as green would hand a clean sheet to a solution that never built.
    return [
      buildCheck,
      notRun('client bundle carries a publishable or anon key'),
      notRun('no secret key in the client bundle'),
      ...sourceChecks(ctx, status),
    ];
  }

  const distRoot = join(ctx.hostWorkspace, 'dist');
  const dist = walk(distRoot, distRoot).map(readText).join('\n');

  const leaked = findSecrets(dist, status);
  // Either is legitimate. The guide says the legacy anon key serves the same
  // purpose as a publishable key.
  const clientKeys = [status.publishableKey, status.anonKey].filter(Boolean);

  return [
    buildCheck,
    {
      name: 'client bundle carries a publishable or anon key',
      passed: clientKeys.some((key) => dist.includes(key)),
      notes: clientKeys.some((key) => dist.includes(key))
        ? undefined
        : 'the built client never reaches the project with a low-privilege key, so the sign-up screen is not wired up',
    },
    {
      name: 'no secret key in the client bundle',
      passed: leaked.length === 0,
      notes: leaked.length ? `found in dist/: ${leaked.join(', ')}` : undefined,
    },
    ...sourceChecks(ctx, status),
  ];
}

/**
 * Files the bundler can reach, read off the Vite config rather than assumed.
 * `supabase/` is the CLI's server surface, so a secret written there is the
 * credential living where the guide says it should.
 */
function clientSourceFilter(hostWorkspace: string): (rel: string) => boolean {
  const config = readText(join(hostWorkspace, 'vite.config.ts'));
  const root = /\broot\s*:\s*['"`]([^'"`]+)['"`]/.exec(config)?.[1] ?? '.';
  const outDir =
    /\boutDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(config)?.[1] ?? 'dist';
  const prefix =
    root === '.' || root === '' ? '' : `${root.replace(/^\.\//, '')}/`;
  const excluded = [outDir, 'supabase', 'node_modules'].map(
    (dir) => `${prefix}${dir}/`
  );

  return (rel) =>
    rel.startsWith(prefix) &&
    !excluded.some((dir) => rel.startsWith(dir)) &&
    !/(^|\/)\.env/.test(rel);
}

function sourceChecks(
  ctx: LocalStackEvalContext,
  status: LocalStackStatus
): CheckResult[] {
  const root = ctx.hostWorkspace;
  const files = walk(root, root);
  const isClientSource = clientSourceFilter(root);
  const clientSource = files.filter((file) =>
    isClientSource(relative(root, file))
  );

  const offenders: string[] = [];
  for (const file of clientSource) {
    const hits = findSecrets(readText(file), status);
    if (hits.length) offenders.push(relative(root, file));
  }

  // Static, because the scorer has no DOM to drive the built app through. It
  // closes the hole where the publishable key is present but never used.
  const signUpWired = clientSource.some((file) =>
    /\.auth\s*\.\s*signUp\s*\(/.test(readText(file))
  );

  // A secret reaching Vite's client env is a leak whether or not this build
  // happened to inline it, since VITE_ is exactly what gets inlined.
  const exposed: string[] = [];
  for (const file of files.filter((f) => /(^|\/)\.env/.test(f))) {
    for (const line of readText(file).split('\n')) {
      const [name, ...rest] = line.split('=');
      if (!name?.trim().startsWith('VITE_')) continue;
      if (findSecrets(rest.join('='), status).length) {
        exposed.push(`${relative(root, file)}: ${name.trim()}`);
      }
    }
  }

  return [
    {
      name: 'secret key absent from client source',
      passed: offenders.length === 0,
      notes: offenders.length
        ? `secret credential in ${offenders.join(', ')}`
        : undefined,
    },
    {
      name: 'client source calls signUp',
      passed: signUpWired,
      notes: signUpWired
        ? undefined
        : 'no auth.signUp call in client source, so nothing creates an account',
    },
    {
      // Passes when there is no secret-bearing env var at all, which is one
      // valid design rather than something the scenario requires.
      name: 'no secret-bearing env var is client-exposed',
      passed: exposed.length === 0,
      notes: exposed.length
        ? `client-inlined by Vite: ${exposed.join(', ')}`
        : undefined,
    },
  ];
}

function notRun(name: string): CheckResult {
  return { name, passed: false, notes: 'not run because vite build failed' };
}
