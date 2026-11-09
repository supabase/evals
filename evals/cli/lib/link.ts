import type { LocalStackEvalContext } from '@supabase-evals/core';
import { describeFailure, errorMessage } from './shell.js';

export const LINK_PATH = 'supabase/.temp/project-ref';

export type LinkState =
  | { ok: true; ref: string | null }
  | { ok: false; notes: string };

/** The project ref `supabase link` left in the repo, or null when there is none. */
export async function readLinkState(
  ctx: Pick<LocalStackEvalContext, 'exec'>
): Promise<LinkState> {
  try {
    const result = await ctx.exec(`cat ${LINK_PATH}`);
    if (result.ok) return { ok: true, ref: result.stdout.trim() || null };
    if (result.stderr.includes('No such file or directory')) {
      return { ok: true, ref: null };
    }
    return {
      ok: false,
      notes: `could not read ${LINK_PATH} (${describeFailure(result)})`,
    };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}
