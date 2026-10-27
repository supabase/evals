import type { CheckResult } from '@supabase-evals/core';
import type { AppEnv } from './env-files.js';
import type { HostedFacts } from './hosted.js';
import { findSecretTokens } from './secrets.js';

export const URL_VAR = 'VITE_SUPABASE_URL';
export const KEY_VAR = 'VITE_SUPABASE_PUBLISHABLE_KEY';

export const URL_CHECK_NAME = "the app's config points at our project";
export const KEY_CHECK_NAME =
  "the app's config holds a client key for our project";

type KeyKind = 'unset' | 'client' | 'secret' | 'other';

const KEY_PHRASES = {
  secret: 'holds a secret key, not a client key',
  other: "holds a value that is not one of our project's client keys",
} as const;

function parseUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.hostname === '' ? undefined : url;
  } catch {
    return undefined;
  }
}

/** The hostname of a URL value, or undefined when it is unset or not a URL. */
export function urlHostname(value: string | undefined): string | undefined {
  return value === undefined ? undefined : parseUrl(value.trim())?.hostname;
}

/** Whether `value` is unset, one of the project's client keys, a secret key, or something else. */
export function describeKeyValue(
  hosted: HostedFacts,
  value: string | undefined
): KeyKind {
  const key = value ?? '';
  if (key.trim() === '') return 'unset';
  if (hosted.ok && hosted.clientKeys.includes(key)) return 'client';
  const secretKeys = hosted.ok ? hosted.secretKeys : [];
  return findSecretTokens(key, secretKeys).length > 0 ? 'secret' : 'other';
}

const fail = (
  name: string,
  hosted: HostedFacts,
  detail: string
): CheckResult => ({
  name,
  passed: false,
  notes: hosted.ok ? detail : `${hosted.notes}; ${detail}`,
});

function urlProblem(url: URL, ref: string): string | undefined {
  if (url.protocol !== 'https:') return 'is not https';
  if (url.hostname.split('.')[0] !== ref) {
    return `points at ${url.hostname}, not our project`;
  }
  if (url.username !== '' || url.password !== '' || url.port !== '') {
    return 'is not the bare project URL (it has credentials or a port)';
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return 'is not the bare project URL (it has a path, query or fragment)';
  }
  return undefined;
}

export function checkUrlPointsAtProject(
  hosted: HostedFacts,
  env: AppEnv
): CheckResult {
  const name = URL_CHECK_NAME;
  if (!env.ok) return fail(name, hosted, env.notes);
  const entry = env.values[URL_VAR];
  const value = entry?.value.trim();
  if (entry === undefined || !value) {
    return fail(name, hosted, `${URL_VAR} is unset`);
  }
  const where = `${URL_VAR} in ${entry.file}`;
  const url = parseUrl(value);
  if (url === undefined) return fail(name, hosted, `${where} is not a URL`);
  if (!hosted.ok) {
    return fail(name, hosted, `${where} points at ${url.hostname}`);
  }
  const problem = urlProblem(url, hosted.ref);
  return problem === undefined
    ? { name, passed: true }
    : fail(name, hosted, `${where} ${problem}`);
}

export function checkClientKey(hosted: HostedFacts, env: AppEnv): CheckResult {
  const name = KEY_CHECK_NAME;
  if (!env.ok) return fail(name, hosted, env.notes);
  const entry = env.values[KEY_VAR];
  const kind = describeKeyValue(hosted, entry?.value);
  if (kind === 'unset' || entry === undefined) {
    return fail(name, hosted, `${KEY_VAR} is unset`);
  }
  if (kind === 'client') return { name, passed: true };
  return fail(name, hosted, `${KEY_VAR} in ${entry.file} ${KEY_PHRASES[kind]}`);
}
