import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { errorMessage } from '../lib/shell.js';

export const HOSTED_CHECK_NAME = 'a hosted project is available';

export type ApiKeyKind = 'client' | 'secret' | 'unknown';

export type HostedFacts =
  | { ok: true; ref: string; clientKeys: string[]; secretKeys: string[] }
  | { ok: false; notes: string };

export const NO_HOSTED_PROJECT =
  'no hosted project in CI until the staging org lands (CLI-2754): the run has nothing to wire up';

const unreadable = (detail: string): HostedFacts => ({
  ok: false,
  notes: `could not read the project's API keys (${detail})`,
});

/** Publishable and legacy `anon` keys are client keys; secret and legacy `service_role` keys are secret keys. */
export function classifyApiKey(key: {
  name?: string | null;
  type?: string | null;
}): ApiKeyKind {
  if (key.type === 'publishable') return 'client';
  if (key.type === 'secret') return 'secret';
  if (key.name === 'anon') return 'client';
  if (key.name === 'service_role') return 'secret';
  return 'unknown';
}

/** The hosted ref and its revealed API keys, split into client and secret keys. */
export async function readHostedFacts(
  ctx: Pick<LocalStackEvalContext, 'hostedRef' | 'hostedMgmt'>
): Promise<HostedFacts> {
  const { hostedRef, hostedMgmt } = ctx;
  if (!hostedRef || !hostedMgmt) return { ok: false, notes: NO_HOSTED_PROJECT };
  try {
    const res = await hostedMgmt.GET('/v1/projects/{ref}/api-keys', {
      params: { path: { ref: hostedRef }, query: { reveal: true } },
    });
    if (res.error || !res.data) {
      return unreadable(`status ${res.response.status}`);
    }
    const clientKeys: string[] = [];
    const secretKeys: string[] = [];
    for (const key of res.data) {
      if (!key.api_key) continue;
      const kind = classifyApiKey(key);
      if (kind === 'client') clientKeys.push(key.api_key);
      if (kind === 'secret') secretKeys.push(key.api_key);
    }
    if (clientKeys.length === 0) return unreadable('no client key returned');
    return { ok: true, ref: hostedRef, clientKeys, secretKeys };
  } catch (error) {
    return unreadable(errorMessage(error));
  }
}

export function checkHostedProject(hosted: HostedFacts): CheckResult {
  return hosted.ok
    ? { name: HOSTED_CHECK_NAME, passed: true }
    : { name: HOSTED_CHECK_NAME, passed: false, notes: hosted.notes };
}
