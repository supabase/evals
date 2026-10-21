import { readFileSync } from 'node:fs';

export const SECRET_NAMES = [
  'RESEND_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];

/** KEY=VALUE lines; comments (#) and blank lines skipped; value trimmed. */
export function parseEnvFile(text: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at === -1) continue;
    entries[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return entries;
}

function readValues(file: string): Readonly<Record<SecretName, string>> {
  const text = readFileSync(
    new URL(`./local/supabase/functions/${file}`, import.meta.url),
    'utf8'
  );
  const parsed = parseEnvFile(text);
  const missing = SECRET_NAMES.filter((name) => parsed[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`${file} is missing ${missing.join(', ')}`);
  }
  return Object.fromEntries(
    SECRET_NAMES.map((name) => [name, parsed[name]])
  ) as Record<SecretName, string>;
}

export const PRODUCTION_VALUES = readValues('.env.production');

export const DEVELOPMENT_VALUES = readValues('.env.development');
