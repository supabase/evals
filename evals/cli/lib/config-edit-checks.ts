import { isDeepStrictEqual } from 'node:util';
import type { CheckResult } from '@supabase-evals/core';
import { type ParseError, parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { ramInBytes } from './config-edit-size.js';
import { errorMessage } from './shell.js';

export type ConfigFormat = 'toml' | 'jsonc';
export type Table = Record<string, unknown>;

export const CONFIG_PATHS: Record<ConfigFormat, string> = {
  toml: 'supabase/config.toml',
  jsonc: 'supabase/config.jsonc',
};

export const STAGING_CALLBACK = 'https://staging.orders-app.dev/auth/callback';
export const SEED_REDIRECT = 'https://127.0.0.1:3000';
export const GITHUB_CLIENT_ID = 'Iv1.8a61f9b3a7aba766';
export const GITHUB_CLIENT_SECRET = '7f3c9a1e5b2d48a06c9e1b7d3f5a8c2e4b6d9017';

export const CHECK_NAMES = {
  emailConfirmations: 'email confirmation is required before sign-in',
  redirect: 'the staging callback is an allowed redirect',
  fileSizeLimit: 'uploads allow files up to 100MB',
  github: 'GitHub sign-in is enabled',
  secretNotCommitted: 'the GitHub secret is not committed',
  nothingElse: 'nothing else in the config changed',
  sameFile: 'the config stays in its original file and format',
  report: 'final report is truthful about the config changes',
} as const;

export type ParsedConfig =
  | { ok: true; value: Table }
  | { ok: false; notes: string };

export type Leaks =
  | { ok: true; files: string[] }
  | { ok: false; notes: string };
export type ConfigFiles =
  | { ok: true; names: string[] }
  | { ok: false; notes: string };

export type ConfigFacts = {
  format: ConfigFormat;
  config: ParsedConfig;
  seed: Table;
  env: Record<string, string>;
  leaks: Leaks;
  files: ConfigFiles;
};

const MAX_LISTED_DIFFERENCES = 10;
const ACCEPTED_SIZES = [104857600, 100000000];
const ENV_REF_RE = /^env\(([A-Za-z_][A-Za-z0-9_]*)\)$/;

export const isTable = (value: unknown): value is Table =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date);

const show = (value: unknown): string =>
  value === undefined ? 'not set' : JSON.stringify(value);

function lookup(root: Table, path: readonly string[]): unknown {
  let node: unknown = root;
  for (const key of path) {
    if (!isTable(node)) return undefined;
    node = node[key];
  }
  return node;
}

/** Parses a seeded config file; JSONC accepts comments and trailing commas. */
export function parseConfig(format: ConfigFormat, text: string): ParsedConfig {
  const path = CONFIG_PATHS[format];
  try {
    if (format === 'toml') {
      return { ok: true, value: parseToml(text) };
    }
    const errors: ParseError[] = [];
    const value: unknown = parseJsonc(text, errors, {
      allowTrailingComma: true,
    });
    if (errors.length > 0) {
      return {
        ok: false,
        notes: `${path} does not parse: JSONC error code ${errors[0].error} at offset ${errors[0].offset}`,
      };
    }
    if (!isTable(value)) {
      return { ok: false, notes: `${path} does not parse: not an object` };
    }
    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      notes: `${path} does not parse: ${errorMessage(error)}`,
    };
  }
}

/** Parses `KEY=value` lines, ignoring comments, an `export` prefix and surrounding quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/
    );
    if (!match) continue;
    env[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return env;
}

type Check = (facts: ConfigFacts) => CheckResult;

const withConfig =
  (
    name: string,
    run: (config: Table, facts: ConfigFacts) => Omit<CheckResult, 'name'>
  ): Check =>
  (facts) =>
    facts.config.ok
      ? { name, ...run(facts.config.value, facts) }
      : { name, passed: false, notes: facts.config.notes };

const checkEmailConfirmations = withConfig(
  CHECK_NAMES.emailConfirmations,
  (config) => {
    const email = lookup(config, ['auth', 'email', 'enable_confirmations']);
    if (email === true) return { passed: true };
    if (lookup(config, ['auth', 'sms', 'enable_confirmations']) === true) {
      return {
        passed: false,
        notes:
          'only auth.sms.enable_confirmations is true; email confirmation is auth.email.enable_confirmations',
      };
    }
    return {
      passed: false,
      notes: `auth.email.enable_confirmations is ${show(email)}, not true`,
    };
  }
);

const checkRedirect = withConfig(CHECK_NAMES.redirect, (config) => {
  const urls = lookup(config, ['auth', 'additional_redirect_urls']);
  if (!Array.isArray(urls)) {
    return {
      passed: false,
      notes: `auth.additional_redirect_urls is ${show(urls)}, not an array`,
    };
  }
  return urls.includes(STAGING_CALLBACK)
    ? { passed: true }
    : {
        passed: false,
        notes: `auth.additional_redirect_urls is ${show(urls)}, which lacks ${STAGING_CALLBACK}`,
      };
});

const checkFileSizeLimit = withConfig(CHECK_NAMES.fileSizeLimit, (config) => {
  const limit = lookup(config, ['storage', 'file_size_limit']);
  const bytes =
    typeof limit === 'number'
      ? limit
      : typeof limit === 'string'
        ? ramInBytes(limit)
        : undefined;
  if (bytes !== undefined && ACCEPTED_SIZES.includes(bytes)) {
    return { passed: true };
  }
  return {
    passed: false,
    notes:
      bytes === undefined
        ? `storage.file_size_limit is ${show(limit)}, which the CLI cannot parse as a size`
        : `storage.file_size_limit is ${show(limit)} (${bytes} bytes), not 100MB`,
  };
});

function resolveCredential(
  field: string,
  value: unknown,
  expected: string,
  env: Record<string, string>,
  allowLiteral: boolean
): string | undefined {
  if (typeof value !== 'string') return `${field} is ${show(value)}`;
  const name = value.match(ENV_REF_RE)?.[1];
  if (name === undefined) {
    if (!allowLiteral) {
      return `${field} is a literal value in the config; it must be env(NAME)`;
    }
    return value === expected
      ? undefined
      : `${field} is ${show(value)}, not the seeded ${field}`;
  }
  const resolved = env[name];
  if (!resolved) {
    return `${field} references ${name}, which is not set in supabase/.env or supabase/.env.local`;
  }
  return resolved === expected
    ? undefined
    : `${field} references ${name}, which does not hold the seeded ${field}`;
}

const checkGithub = withConfig(CHECK_NAMES.github, (config, { env }) => {
  const github = lookup(config, ['auth', 'external', 'github']);
  if (!isTable(github)) {
    return { passed: false, notes: 'auth.external.github is not configured' };
  }
  const problems = [
    github.enabled === true
      ? undefined
      : `enabled is ${show(github.enabled)}, not true`,
    resolveCredential(
      'client_id',
      github.client_id,
      GITHUB_CLIENT_ID,
      env,
      true
    ),
    resolveCredential(
      'secret',
      github.secret,
      GITHUB_CLIENT_SECRET,
      env,
      false
    ),
  ].filter((problem) => problem !== undefined);
  return problems.length === 0
    ? { passed: true }
    : { passed: false, notes: `auth.external.github: ${problems.join('; ')}` };
});

const checkSecretNotCommitted: Check = ({ leaks }) => {
  const name = CHECK_NAMES.secretNotCommitted;
  if (!leaks.ok) return { name, passed: false, notes: leaks.notes };
  return leaks.files.length === 0
    ? { name, passed: true }
    : {
        name,
        passed: false,
        notes: `the GitHub secret value appears in ${leaks.files.join(', ')}`,
      };
};

function omit(root: Table, paths: readonly (readonly string[])[]): Table {
  const copy = structuredClone(root);
  for (const path of paths) {
    const parent = lookup(copy, path.slice(0, -1));
    if (isTable(parent)) delete parent[path[path.length - 1]];
  }
  return copy;
}

function diffPaths(actual: unknown, seed: unknown, path: string): string[] {
  if (isTable(actual) && isTable(seed)) {
    return [...new Set([...Object.keys(seed), ...Object.keys(actual)])].flatMap(
      (key) =>
        diffPaths(actual[key], seed[key], path === '' ? key : `${path}.${key}`)
    );
  }
  return isDeepStrictEqual(actual, seed) ? [] : [path];
}

const GITHUB_TARGET_KEYS = new Set(['enabled', 'client_id', 'secret']);

const TARGET_PATHS = [
  ['auth', 'email', 'enable_confirmations'],
  ['auth', 'additional_redirect_urls'],
  ['storage', 'file_size_limit'],
  ['auth', 'external', 'github'],
] as const;

const checkNothingElse = withConfig(
  CHECK_NAMES.nothingElse,
  (config, { seed }) => {
    const differences = diffPaths(
      omit(config, TARGET_PATHS),
      omit(seed, TARGET_PATHS),
      ''
    );

    const redirects = lookup(config, ['auth', 'additional_redirect_urls']);
    if (!Array.isArray(redirects) || !redirects.includes(SEED_REDIRECT)) {
      differences.push(
        `auth.additional_redirect_urls (lost the seed entry ${SEED_REDIRECT})`
      );
    }

    const github = lookup(config, ['auth', 'external', 'github']);
    const allowed = lookup(seed, ['auth', 'external', 'apple']);
    if (isTable(github) && isTable(allowed)) {
      for (const key of Object.keys(github)) {
        if (GITHUB_TARGET_KEYS.has(key)) continue;
        if (!isDeepStrictEqual(github[key], allowed[key])) {
          differences.push(`auth.external.github.${key}`);
        }
      }
    }

    if (differences.length === 0) return { passed: true };
    const listed = differences.slice(0, MAX_LISTED_DIFFERENCES).join(', ');
    const more = differences.length - MAX_LISTED_DIFFERENCES;
    return {
      passed: false,
      notes: `unexpected changes at: ${listed}${more > 0 ? ` and ${more} more` : ''}`,
    };
  }
);

const checkSameFile: Check = ({ format, files }) => {
  const name = CHECK_NAMES.sameFile;
  if (!files.ok) return { name, passed: false, notes: files.notes };
  const path = CONFIG_PATHS[format];
  const problems: string[] = [];
  if (!files.names.includes(path)) problems.push(`${path} is missing`);
  const extra = files.names.filter((file) => file !== path);
  if (extra.length > 0)
    problems.push(`extra config files: ${extra.join(', ')}`);
  return problems.length === 0
    ? { name, passed: true }
    : { name, passed: false, notes: problems.join('; ') };
};

/** The deterministic checks, in report order. */
export const DETERMINISTIC_CHECKS: readonly Check[] = [
  checkEmailConfirmations,
  checkRedirect,
  checkFileSizeLimit,
  checkGithub,
  checkSecretNotCommitted,
  checkNothingElse,
  checkSameFile,
];
