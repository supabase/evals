import { join, relative } from 'node:path';
import type {
  CheckResult,
  LocalStackEvalContext,
  LocalStackStatus,
} from '@supabase-evals/core';

import { readText, walk } from './files.js';
import { findSecrets } from './keys.js';

export type BundleChecks = {
  viteBuild: CheckResult;
  clientKey: CheckResult;
  noSecretInBundle: CheckResult;
  noSecretInSource: CheckResult;
  signUpWired: CheckResult;
  noExposedEnvVar: CheckResult;
};

export async function checkBundle(
  ctx: LocalStackEvalContext,
  status: LocalStackStatus
): Promise<BundleChecks> {
  const build = await ctx.runViteBuild();
  const viteBuild: CheckResult = {
    name: 'vite build passed',
    passed: build.ok,
    notes: build.ok
      ? undefined
      : (build.stderr || build.stdout).trim().slice(0, 4000),
  };

  if (!build.ok) {
    // Not a pass. A missing bundle is the absence of evidence, and reporting
    // these as green would hand a clean sheet to a solution that never built.
    return {
      viteBuild,
      clientKey: notRun('client bundle carries a publishable or anon key'),
      noSecretInBundle: notRun('no secret key in the client bundle'),
      ...sourceChecks(ctx, status),
    };
  }

  const distRoot = join(ctx.hostWorkspace, 'dist');
  const dist = walk(distRoot, distRoot).map(readText).join('\n');

  const leaked = findSecrets(dist, status);
  const clientKeys = [status.publishableKey, status.anonKey].filter(Boolean);
  const carriesClientKey = clientKeys.some((key) => dist.includes(key));

  return {
    viteBuild,
    clientKey: {
      name: 'client bundle carries a publishable or anon key',
      passed: carriesClientKey,
      notes: carriesClientKey
        ? undefined
        : 'the built client never reaches the project with a low-privilege key, so the sign-up screen is not wired up',
    },
    noSecretInBundle: {
      name: 'no secret key in the client bundle',
      passed: leaked.length === 0,
      notes: leaked.length ? `found in dist/: ${leaked.join(', ')}` : undefined,
    },
    ...sourceChecks(ctx, status),
  };
}

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
): Pick<BundleChecks, 'noSecretInSource' | 'signUpWired' | 'noExposedEnvVar'> {
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

  // The client project's env, meaning any `.env` outside `supabase/`. A secret
  // there is exposed whichever name it sits behind and whichever prefix the
  // bundler inlines, so neither is parsed.
  const exposed: string[] = [];
  for (const file of files) {
    const rel = relative(root, file);
    if (!/(^|\/)\.env/.test(rel) || rel.startsWith('supabase/')) continue;
    for (const line of readText(file).split('\n')) {
      const [name, ...rest] = line.split('=');
      if (!name || !rest.length) continue;
      if (findSecrets(rest.join('='), status).length) {
        exposed.push(`${rel}: ${name.trim().replace(/^export\s+/, '')}`);
      }
    }
  }

  return {
    noSecretInSource: {
      name: 'secret key absent from client source',
      passed: offenders.length === 0,
      notes: offenders.length
        ? `secret credential in ${offenders.join(', ')}`
        : undefined,
    },
    signUpWired: {
      name: 'client source contains a signUp call',
      passed: signUpWired,
      notes: signUpWired
        ? undefined
        : 'no auth.signUp call in client source, so nothing creates an account',
    },
    noExposedEnvVar: {
      // Passes when there is no secret-bearing env var at all, which is one
      // valid design rather than something the scenario requires.
      name: 'no secret-bearing env var is client-exposed',
      passed: exposed.length === 0,
      notes: exposed.length
        ? `client-inlined by Vite: ${exposed.join(', ')}`
        : undefined,
    },
  };
}

function notRun(name: string): CheckResult {
  return { name, passed: false, notes: 'not run because vite build failed' };
}
