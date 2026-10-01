import type { LocalStackEvalContext } from '@supabase-evals/core';
import { errorMessage } from './shell.js';

const DEFAULT_MAX_DEPTH = 4;

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function matchProjectDir(
  name: string,
  dirs: readonly string[]
): { dir: string } | { problem: string } {
  const exact = dirs.filter((dir) => basename(dir) === name);
  if (exact.length === 1) return { dir: exact[0] };
  if (exact.length > 1) {
    return { problem: `ambiguous (${exact.join(', ')})` };
  }
  const partial = dirs.filter((dir) => basename(dir).includes(name));
  if (partial.length === 1) return { dir: partial[0] };
  return {
    problem:
      partial.length === 0
        ? 'no matching project directory'
        : `ambiguous (${partial.join(', ')})`,
  };
}

/**
 * Locates every `supabase/config.toml` under the workspace and maps each name
 * to its project directory, preferring an exact basename match and falling
 * back to a unique substring match. Names resolve independently, so one
 * missing project never hides the others.
 */
export async function findProjectDirs<N extends string>(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  names: readonly N[],
  opts: { maxDepth?: number } = {}
): Promise<{
  found: Partial<Record<N, string>>;
  problems: Partial<Record<N, string>>;
  all: string[];
}> {
  const found: Partial<Record<N, string>> = {};
  const problems: Partial<Record<N, string>> = {};
  let all: string[];
  try {
    const result = await ctx.exec(
      `find . -maxdepth ${opts.maxDepth ?? DEFAULT_MAX_DEPTH} -path '*/supabase/config.toml' -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null`
    );
    all = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((path) => path.replace(/\/supabase\/config\.toml$/, ''));
  } catch (error) {
    const msg = errorMessage(error);
    for (const name of names) problems[name] = msg;
    return { found, problems, all: [] };
  }

  for (const name of names) {
    const match = matchProjectDir(name, all);
    if ('dir' in match) found[name] = match.dir;
    else problems[name] = match.problem;
  }
  return { found, problems, all };
}
