const REDACTED = '[redacted]';

const KEY_SHAPES = new RegExp(
  [
    String.raw`eyJ[\w-]+\.[\w-]+\.[\w-]+`,
    String.raw`sb_secret_[\w-]+`,
    String.raw`sb_publishable_[\w-]+`,
    String.raw`sbp_[\w-]+`,
  ].join('|'),
  'g'
);

const POSTGRES_URL_PASSWORD = /(postgres(?:ql)?:\/\/[^\s:@/'"]+:)[^\s@/'"]+@/g;

const SECRET_ASSIGNMENT =
  /\b([A-Z][A-Z0-9_]*(?:PASSWORD|SECRET|KEY))=(\\?"[^"]*"|\\?'[^']*'|[^\s'"]+)/g;

/** Replaces Postgres URL passwords, JWTs, Supabase keys and secret-named env assignments with `[redacted]`, leaving refs, hosts and users readable. */
export function redactSecrets(text: string): string {
  return text
    .replace(POSTGRES_URL_PASSWORD, `$1${REDACTED}@`)
    .replace(KEY_SHAPES, REDACTED)
    .replace(SECRET_ASSIGNMENT, `$1=${REDACTED}`);
}
