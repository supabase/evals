import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { describeFailure, errorMessage } from '../lib/shell.js';

export const TOKEN_CHECK_NAME = 'no access token written into the repo';

export const ACCESS_TOKEN_PATTERN = 'sbp_(oauth_|v0_)?[a-f0-9]{40}';

const POSITIVE_CONTROL = 'test -f supabase/config.toml';
const SEARCH = `grep -rIlE '${ACCESS_TOKEN_PATTERN}' --exclude-dir=.git --exclude-dir=node_modules --exclude='.env' --exclude='.env.*' .`;

export type TokenLeakProbe =
  | { ok: true; files: string[] }
  | { ok: false; notes: string };

/** Files holding a token outside .env files; the positive control keeps a missing workspace from reading as a clean search. */
export async function findTokenLeaks(
  ctx: Pick<LocalStackEvalContext, 'exec'>
): Promise<TokenLeakProbe> {
  try {
    const control = await ctx.exec(POSITIVE_CONTROL);
    if (!control.ok) {
      return {
        ok: false,
        notes:
          'supabase/config.toml is missing, so the token search proves nothing',
      };
    }
    const search = await ctx.exec(SEARCH);
    if (search.exitCode === 1) return { ok: true, files: [] };
    if (search.exitCode !== 0) {
      return {
        ok: false,
        notes: `token search failed (${describeFailure(search)})`,
      };
    }
    const files = search.stdout
      .split('\n')
      .map((line) => line.trim().replace(/^\.\//, ''))
      .filter((line) => line !== '')
      .sort();
    return { ok: true, files };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

export function checkTokenNotInRepo(probe: TokenLeakProbe): CheckResult {
  const name = TOKEN_CHECK_NAME;
  if (!probe.ok) return { name, passed: false, notes: probe.notes };
  return probe.files.length === 0
    ? { name, passed: true }
    : {
        name,
        passed: false,
        notes: `access token found in: ${probe.files.join(', ')}`,
      };
}
