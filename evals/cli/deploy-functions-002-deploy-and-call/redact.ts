import type { LocalStackEvalContext } from '@supabase-evals/core';

const REDACTED = '[redacted]';
const MIN_SECRET_LENGTH = 8;

const KEY_SHAPES = [
  String.raw`eyJ[\w-]+\.[\w-]+\.[\w-]+`,
  String.raw`sb_secret_[\w-]+`,
  String.raw`sb_publishable_[\w-]+`,
  String.raw`sbp_[\w-]+`,
];

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replaces the known secret values and anything shaped like a JWT or a Supabase key with `[redacted]`. */
export function redactSecrets(
  text: string,
  secrets: readonly string[]
): string {
  const known = secrets
    .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  return text.replace(
    new RegExp([...known, ...KEY_SHAPES].join('|'), 'g'),
    REDACTED
  );
}

/** Lists every key value the hosted project has, or none when there is no project or the lookup fails. */
export async function readProjectKeys(
  ctx: Pick<LocalStackEvalContext, 'hostedMgmt' | 'hostedRef'>
): Promise<string[]> {
  const { hostedMgmt, hostedRef } = ctx;
  if (!hostedMgmt || hostedRef === undefined) return [];
  try {
    const res = await hostedMgmt.GET('/v1/projects/{ref}/api-keys', {
      params: { path: { ref: hostedRef } },
    });
    if (res.error || !res.data) return [];
    return res.data.flatMap(({ api_key }) => (api_key ? [api_key] : []));
  } catch {
    return [];
  }
}
