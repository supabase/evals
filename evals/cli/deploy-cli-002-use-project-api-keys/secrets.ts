import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { describeFailure, errorMessage, shellQuote } from '../lib/shell.js';
import {
  describeReadFailure,
  type EnvEntry,
  parseDotenv,
  resolveViteEnv,
  VITE_DEV_ENV_FILES,
  VITE_PRODUCTION_ENV_FILES,
} from './env-files.js';

export const SECRET_CHECK_NAME =
  'no secret key is exposed to the browser or the repo';

export type SecretExposureProbe =
  | { ok: true; exposures: string[]; storedPrivately: string[] }
  | { ok: false; notes: string };

const POSITIVE_CONTROL = 'test -f supabase/config.toml';
const SECRET_KEY_SHAPE = /(?<![\w-])sb_secret_([\w-]{22})_[\w-]{8}(?![\w-])/g;
const MIN_DISTINCT_KEY_CHARS = 8;
const ACCESS_TOKEN_SHAPE =
  /(?<![\w-])sbp_(?:oauth_|v0_)?[a-f0-9]{40}(?![\w-])/g;
const JWT_SHAPE = /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g;
const ROOT_ENV_FILE = /^\.env(\..+)?$/;
const BROWSER_PREFIX = 'VITE_';
const VITE_MODES = [
  ['development', VITE_DEV_ENV_FILES],
  ['production', VITE_PRODUCTION_ENV_FILES],
] as const;

function isServiceRoleJwt(jwt: string): boolean {
  try {
    const payload = JSON.parse(
      Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')
    );
    return payload?.role === 'service_role';
  } catch {
    return false;
  }
}

/** Secret tokens in text: the known secrets, `sb_secret_` keys, `service_role` JWTs and `sbp_` access tokens. */
export function findSecretTokens(
  text: string,
  knownSecrets: readonly string[]
): string[] {
  const found = new Set<string>();
  for (const secret of knownSecrets) {
    if (secret !== '' && text.includes(secret)) found.add(secret);
  }
  for (const [key, body] of text.matchAll(SECRET_KEY_SHAPE)) {
    if (new Set(body).size >= MIN_DISTINCT_KEY_CHARS) found.add(key);
  }
  for (const [token] of text.matchAll(ACCESS_TOKEN_SHAPE)) found.add(token);
  for (const [jwt] of text.matchAll(JWT_SHAPE)) {
    if (isServiceRoleJwt(jwt)) found.add(jwt);
  }
  return [...found];
}

// Only shapes go on the command line, so the project's secret key values never reach the sandbox's process list or logs.
const SEARCH_COMMAND =
  "grep -rlIF --null --exclude-dir=node_modules --exclude-dir=.git -e 'sb_secret_' -e 'sbp_' -e 'eyJ' .";

// grep -r skips symlinks, but Vite loads a symlinked env file, so root env files are always read.
const ROOT_ENV_FILES_COMMAND =
  "find -L . -maxdepth 1 -name '.env*' -type f -print0";

// A throwaway repo supplies the git plumbing; the workspace's own .gitignore files supply the rules.
const checkIgnoreCommand = (files: readonly string[]) =>
  `T=$(mktemp -d) && git init -q "$T" && printf '%s\\0' ${files.map(shellQuote).join(' ')} | git --git-dir="$T/.git" --work-tree=. check-ignore -z --stdin; s=$?; rm -rf "$T"; exit $s`;

const nulSeparatedPaths = (text: string) =>
  text
    .split('\0')
    .map((path) => path.replace(/^\.\//, ''))
    .filter((path) => path !== '');

const shippedLiterally = (name: string, file: string) =>
  `${name} in ${file} ships a secret key to the browser`;

type ModeEnv = { mode: string; env: Record<string, EnvEntry> };

const resolveModes = (envTexts: ReadonlyMap<string, string>): ModeEnv[] =>
  VITE_MODES.map(([mode, files]) => ({
    mode,
    env: resolveViteEnv(
      files.flatMap((file) => {
        const text = envTexts.get(file);
        return text === undefined ? [] : [{ file, text }];
      })
    ),
  }));

const VITE_LOADED_FILES = new Set<string>([
  ...VITE_DEV_ENV_FILES,
  ...VITE_PRODUCTION_ENV_FILES,
]);

/** A secret in a VITE_ variable of a root env file fails whether or not Vite ships it; the wording says which. */
function describeLiteralExposure(
  name: string,
  file: string,
  modeEnvs: readonly ModeEnv[],
  knownSecrets: readonly string[]
): string {
  const shipped = modeEnvs.some(({ env }) => {
    const entry = env[name];
    return (
      entry?.file === file &&
      findSecretTokens(entry.value, knownSecrets).length > 0
    );
  });
  if (shipped) return shippedLiterally(name, file);
  return VITE_LOADED_FILES.has(file)
    ? `${name} in ${file} holds a secret key (overridden, so not currently shipped)`
    : `${name} in ${file} holds a secret key (Vite doesn't load this file in dev or production)`;
}

/** VITE_ variables whose expanded value, in dev or production mode, holds a secret that the file it comes from doesn't hold literally. */
function shippedByExpansion(
  modeEnvs: readonly ModeEnv[],
  knownSecrets: readonly string[],
  reported: readonly string[]
): string[] {
  const shipped = new Map<
    string,
    { name: string; file: string; modes: string[] }
  >();
  for (const { mode, env } of modeEnvs) {
    for (const [name, { value, file }] of Object.entries(env)) {
      if (!name.startsWith(BROWSER_PREFIX)) continue;
      if (reported.includes(shippedLiterally(name, file))) continue;
      if (findSecretTokens(value, knownSecrets).length === 0) continue;
      const id = `${name}@${file}`;
      const entry = shipped.get(id) ?? { name, file, modes: [] };
      entry.modes.push(mode);
      shipped.set(id, entry);
    }
  }
  return [...shipped.values()].map(
    ({ name, file, modes }) =>
      `${name} (${modes.join(' and ')} env, via ${file}) ships a secret key to the browser`
  );
}

/** Files in the workspace that hold a secret key, judged by what reaches the browser and what git would commit; the positive control keeps a missing workspace from reading as a clean search. */
export async function findExposedSecrets(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  knownSecrets: readonly string[]
): Promise<SecretExposureProbe> {
  try {
    const control = await ctx.exec(POSITIVE_CONTROL);
    if (!control.ok) {
      return {
        ok: false,
        notes: 'supabase/config.toml is missing, so the search proves nothing',
      };
    }

    const search = await ctx.exec(SEARCH_COMMAND);
    if (search.exitCode !== 0 && search.exitCode !== 1) {
      return {
        ok: false,
        notes: `secret search failed (${describeFailure(search)})`,
      };
    }

    const envFiles = await ctx.exec(ROOT_ENV_FILES_COMMAND);
    if (!envFiles.ok) {
      return {
        ok: false,
        notes: `could not list the root env files (${describeFailure(envFiles)})`,
      };
    }

    const candidates = new Set([
      ...(search.exitCode === 0 ? nulSeparatedPaths(search.stdout) : []),
      ...nulSeparatedPaths(envFiles.stdout),
    ]);
    const holders: { file: string; text: string }[] = [];
    const envTexts = new Map<string, string>();
    for (const file of candidates) {
      const read = await ctx.exec(`cat -- ${shellQuote(file)}`);
      if (!read.ok) {
        return {
          ok: false,
          notes: `could not read ${file} (${describeReadFailure(read)})`,
        };
      }
      if (ROOT_ENV_FILE.test(file)) envTexts.set(file, read.stdout);
      if (findSecretTokens(read.stdout, knownSecrets).length > 0) {
        holders.push({ file, text: read.stdout });
      }
    }

    const ignored = new Set<string>();
    if (holders.length > 0) {
      const check = await ctx.exec(
        checkIgnoreCommand(holders.map(({ file }) => file))
      );
      if (check.exitCode === 0) {
        for (const file of nulSeparatedPaths(check.stdout)) ignored.add(file);
      } else if (check.exitCode !== 1) {
        return {
          ok: false,
          notes: `could not ask git which files are ignored (${describeFailure(check)})`,
        };
      }
    }

    const modeEnvs = resolveModes(envTexts);
    const exposures: string[] = [];
    const storedPrivately: string[] = [];
    for (const { file, text } of holders) {
      const isIgnored = ignored.has(file);
      if (!isIgnored) {
        exposures.push(`${file} would be committed with a secret key`);
      }
      const named: string[] = [];
      let flagged = false;
      if (ROOT_ENV_FILE.test(file)) {
        for (const [name, value] of Object.entries(parseDotenv(text))) {
          if (findSecretTokens(value, knownSecrets).length === 0) continue;
          if (name.startsWith(BROWSER_PREFIX)) {
            flagged = true;
            exposures.push(
              describeLiteralExposure(name, file, modeEnvs, knownSecrets)
            );
          } else {
            named.push(`${name} in ${file}`);
          }
        }
      }
      if (!isIgnored) continue;
      if (named.length > 0) storedPrivately.push(...named);
      else if (!flagged) storedPrivately.push(file);
    }
    exposures.push(...shippedByExpansion(modeEnvs, knownSecrets, exposures));
    return { ok: true, exposures, storedPrivately };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

export function checkNoSecretExposed(probe: SecretExposureProbe): CheckResult {
  const name = SECRET_CHECK_NAME;
  if (!probe.ok) return { name, passed: false, notes: probe.notes };
  return probe.exposures.length === 0
    ? { name, passed: true }
    : { name, passed: false, notes: probe.exposures.join('; ') };
}
