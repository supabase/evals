import { join, relative } from 'node:path';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';

import { readText, walk } from './files.js';
import { PROVIDER_KEY } from './fixture.js';

export type ClientChecks = {
  build: CheckResult;
  notInBundle: CheckResult;
  noExposedEnvVar: CheckResult;
  notInSource: CheckResult;
};

/**
 * What a browser can reach. The bundle scan is the load-bearing one: it reads
 * the artifact Vite actually emitted, so an alias, a computed `envPrefix`, or a
 * wrapper around the call cannot hide the value the way a source-level scan can
 * be fooled.
 */
export async function checkClient(
  ctx: LocalStackEvalContext
): Promise<ClientChecks> {
  const result = await ctx.runViteBuild();
  const build: CheckResult = {
    name: 'the client bundle builds',
    passed: result.ok,
    notes: result.ok
      ? undefined
      : (result.stderr || result.stdout).trim().slice(0, 4000),
  };

  const sources = sourceChecks(ctx);

  if (!result.ok) {
    // Not a pass. A missing bundle is the absence of evidence, and reporting it
    // green hands a clean sheet to a workspace that never built.
    return {
      build,
      notInBundle: {
        name: 'the provider key is absent from the built client bundle',
        passed: false,
        notes: 'not run because the client bundle did not build',
      },
      ...sources,
    };
  }

  const distRoot = join(ctx.hostWorkspace, 'dist');
  const offenders = walk(distRoot, distRoot)
    .filter((file) => readText(file).includes(PROVIDER_KEY))
    .map((file) => relative(distRoot, file));

  return {
    build,
    notInBundle: {
      name: 'the provider key is absent from the built client bundle',
      passed: offenders.length === 0,
      notes: offenders.length
        ? `provider key shipped to the browser in dist/${offenders.join(', dist/')}`
        : undefined,
    },
    ...sources,
  };
}

function sourceChecks(
  ctx: LocalStackEvalContext
): Pick<ClientChecks, 'noExposedEnvVar' | 'notInSource'> {
  const root = ctx.hostWorkspace;
  const files = walk(root, root);

  // Every client source file, not the first one that matches. A workspace can
  // hold one screen that was cleaned up and one that was missed.
  const inSource = files
    .map((file) => relative(root, file))
    .filter(
      (rel) =>
        !rel.startsWith('dist/') &&
        !rel.startsWith('supabase/') &&
        !/(^|\/)\.env/.test(rel) &&
        readText(join(root, rel)).includes(PROVIDER_KEY)
    );

  // The client project's env, meaning any `.env` outside `supabase/`. Whether
  // Vite inlines a given name depends on a prefix the config can compute, so
  // the name is not parsed and the whole file is treated as the web project's
  // territory. The credential does not belong in it either way.
  const exposed: string[] = [];
  for (const file of files) {
    const rel = relative(root, file);
    if (!/(^|\/)\.env/.test(rel) || rel.startsWith('supabase/')) continue;
    for (const line of readText(file).split('\n')) {
      const [name, ...rest] = line.split('=');
      if (!name || rest.length === 0) continue;
      if (rest.join('=').includes(PROVIDER_KEY)) {
        exposed.push(`${rel}: ${name.trim().replace(/^export\s+/, '')}`);
      }
    }
  }

  return {
    notInSource: {
      name: 'the provider key is absent from every client source file',
      passed: inSource.length === 0,
      notes: inSource.length
        ? `provider key still in ${inSource.join(', ')}`
        : undefined,
    },
    noExposedEnvVar: {
      // Passes when the project has no env file at all, which is one valid
      // shape rather than something the scenario requires.
      name: "the provider key is absent from the client project's env files",
      passed: exposed.length === 0,
      notes: exposed.length
        ? `in the web project's env: ${exposed.join(', ')}`
        : undefined,
    },
  };
}
