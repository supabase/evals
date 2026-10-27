import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { errorMessage, shellQuote } from '../lib/shell.js';
import { KEY_VAR, URL_VAR } from './config.js';
import { describeReadFailure } from './env-files.js';

export const APP_SOURCE_CHECK_NAME =
  'the app still reads its URL and key from that config';

export type AppSource =
  | { ok: true; missing: string[] }
  | { ok: false; notes: string };

const VARIABLES = [URL_VAR, KEY_VAR];

// Exit 1 means "not referenced"; any other grep failure is an unreadable source, not an absent variable.
const SEARCH_COMMAND = [
  'set --;',
  'for p in src index.html; do [ -e "$p" ] && set -- "$@" "$p"; done;',
  '[ $# -gt 0 ] || exit 0;',
  `for v in ${VARIABLES.map(shellQuote).join(' ')}; do`,
  'grep -rqwF --exclude-dir=node_modules -e "$v" "$@"; rc=$?;',
  'if [ $rc -eq 0 ]; then echo "$v"; elif [ $rc -ne 1 ]; then exit $rc; fi;',
  'done',
].join(' ');

/** Which of the config's variables the app's `src/` and `index.html` no longer mention as whole words. */
export async function readAppSource(
  ctx: Pick<LocalStackEvalContext, 'exec'>
): Promise<AppSource> {
  try {
    const result = await ctx.exec(SEARCH_COMMAND);
    if (!result.ok) {
      return {
        ok: false,
        notes: `could not search src/ and index.html (${describeReadFailure(result)})`,
      };
    }
    const found = new Set(result.stdout.split('\n').map((line) => line.trim()));
    return { ok: true, missing: VARIABLES.filter((name) => !found.has(name)) };
  } catch (error) {
    return {
      ok: false,
      notes: `could not search src/ and index.html (${errorMessage(error)})`,
    };
  }
}

export function checkAppReadsConfig(source: AppSource): CheckResult {
  const name = APP_SOURCE_CHECK_NAME;
  if (!source.ok) return { name, passed: false, notes: source.notes };
  if (source.missing.length === 0) return { name, passed: true };
  return {
    name,
    passed: false,
    notes: `the app's source no longer reads ${source.missing.join(' or ')}`,
  };
}
