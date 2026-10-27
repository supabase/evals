import type { LocalStackEvalContext } from '@supabase-evals/core';

/** Whether the workspace is a Git work tree; null when git could not say. */
export async function readWorkspaceGitRepo(
  ctx: Pick<LocalStackEvalContext, 'exec'>
): Promise<boolean | null> {
  try {
    const result = await ctx.exec('git rev-parse --is-inside-work-tree');
    if (result.ok) return result.stdout.trim() === 'true' ? true : null;
    return result.stderr.includes('not a git repository') ? false : null;
  } catch {
    return null;
  }
}
