import { parseEnv } from 'node:util';
import { readEnvVariable } from '@supabase-evals/core';

export const SECRET_NAMES = [
  'RESEND_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];

/** The variables of dotenv text, as Node parses them. */
export const parseEnvFile = (text: string): Record<string, string> =>
  parseEnv(text) as Record<string, string>;

function readValues(file: string): Readonly<Record<SecretName, string>> {
  const path = new URL(`./local/supabase/functions/${file}`, import.meta.url);
  return Object.fromEntries(
    SECRET_NAMES.map((name) => [name, readEnvVariable(path, name)])
  ) as Record<SecretName, string>;
}

export const PRODUCTION_VALUES = readValues('.env.production');

export const DEVELOPMENT_VALUES = readValues('.env.development');
