import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  CommandResult,
  LocalStackEvalContext,
  ManagementApiClient,
  ToolCallRecord,
} from '@supabase-evals/core';
import { expect, vi } from 'vitest';
import type { AppEnv } from './env-files.js';
import { type HostedFacts, NO_HOSTED_PROJECT } from './hosted.js';
import type { SecretExposureProbe } from './secrets.js';

export type ExecCtx = Pick<LocalStackEvalContext, 'exec'>;

export const HOSTED_REF = 'abcdefghijklmnopqrst';
export const OTHER_REF = 'zyxwvutsrqponmlkjihg';
export const PROJECT_URL = `https://${HOSTED_REF}.supabase.co`;
export const LOCAL_URL = 'http://127.0.0.1:54321';

export const APP_URL_VAR = 'VITE_SUPABASE_URL';
export const APP_KEY_VAR = 'VITE_SUPABASE_PUBLISHABLE_KEY';

const b64url = (text: string) => Buffer.from(text).toString('base64url');

/** Decodes like a Supabase key but the signature segment is the literal `do-not-use`. */
export const fakeJwt = (payload: Record<string, unknown>) =>
  [
    b64url('{"alg":"HS256","typ":"JWT"}'),
    b64url(JSON.stringify(payload)),
    'do-not-use',
  ].join('.');

export const ANON_KEY = fakeJwt({ role: 'anon', iss: 'evals-fixture' });
export const SERVICE_ROLE_KEY = fakeJwt({
  role: 'service_role',
  iss: 'evals-fixture',
});
export const LOCAL_ANON_KEY = fakeJwt({
  role: 'anon',
  iss: 'evals-local-stack',
});
export const PUBLISHABLE_KEY = 'sb_publishable_evalfixture_do_not_use';
export const secretKeyWith = (body: string, tail = 'abcd1234') =>
  `sb_secret_${body}_${tail}`;
export const SECRET_KEY = secretKeyWith('EvalFixtureDoNotUse123');
export const OTHER_PROJECT_SECRET_KEY = secretKeyWith(
  'EvalFixtureOtherProj12',
  'abcd5678'
);
export const CLI_LOCAL_SECRET_KEY = secretKeyWith(
  'N7UND0UgjKTVK-Uodkm0Hg',
  'xSvEMPvz'
);
export const PERSONAL_ACCESS_TOKEN = `sbp_${'e'.repeat(40)}`;
export const PLACEHOLDER_KEY = 'your-key';

/** Keys with no recognisable shape, so only a known-value match can find them. */
export const OPAQUE_CLIENT_KEY = 'evals-fixture-opaque-client-key-do-not-use';
export const OPAQUE_SECRET_KEY = 'evals-fixture-opaque-secret-key-do-not-use';

export const FIXTURE_KEY_VALUES = [
  ANON_KEY,
  SERVICE_ROLE_KEY,
  LOCAL_ANON_KEY,
  PUBLISHABLE_KEY,
  SECRET_KEY,
  PERSONAL_ACCESS_TOKEN,
  OPAQUE_CLIENT_KEY,
  OPAQUE_SECRET_KEY,
];

export function expectNoKeyValues(text: string | undefined) {
  for (const key of FIXTURE_KEY_VALUES) {
    expect(text ?? '').not.toContain(key);
  }
}

export type ApiKeyRow = {
  name: string;
  api_key?: string | null;
  type?: 'legacy' | 'publishable' | 'secret' | null;
};

export const LEGACY_KEY_ROWS: ApiKeyRow[] = [
  { name: 'anon', api_key: ANON_KEY, type: 'legacy' },
  { name: 'service_role', api_key: SERVICE_ROLE_KEY, type: 'legacy' },
];

export const NEW_KEY_ROWS: ApiKeyRow[] = [
  { name: 'default', api_key: PUBLISHABLE_KEY, type: 'publishable' },
  { name: 'default', api_key: SECRET_KEY, type: 'secret' },
];

type MgmtResponse =
  | { data?: ApiKeyRow[]; error?: unknown; status?: number }
  | Error;

export function fakeMgmt(response: MgmtResponse) {
  const GET = vi.fn(async (_path: string, _options?: unknown) => {
    if (response instanceof Error) throw response;
    return {
      data: response.data,
      error: response.error,
      response: { status: response.status ?? 200 },
    };
  });
  return { mgmt: { GET } as unknown as ManagementApiClient, GET };
}

export function hostedContext(rows: ApiKeyRow[] = LEGACY_KEY_ROWS) {
  const { mgmt, GET } = fakeMgmt({ data: rows });
  return { hostedRef: HOSTED_REF, hostedMgmt: mgmt, GET };
}

export const HOSTED_OK: HostedFacts = {
  ok: true,
  ref: HOSTED_REF,
  clientKeys: [ANON_KEY, PUBLISHABLE_KEY],
  secretKeys: [SERVICE_ROLE_KEY, SECRET_KEY],
};

export const HOSTED_ABSENT: HostedFacts = {
  ok: false,
  notes: NO_HOSTED_PROJECT,
};

type EnvEntry = string | readonly [value: string, file: string];

export function appEnv(entries: Record<string, EnvEntry>): AppEnv {
  const values: Record<string, { value: string; file: string }> = {};
  const files = new Set<string>();
  for (const [name, entry] of Object.entries(entries)) {
    const [value, file] =
      typeof entry === 'string' ? [entry, '.env.local'] : entry;
    values[name] = { value, file };
    files.add(file);
  }
  return { ok: true, values, files: [...files] };
}

export const NO_ENV: AppEnv = appEnv({});

export const ENV_FAILED: AppEnv = {
  ok: false,
  notes:
    'could not read .env.local (exit 1: cat: .env.local: Permission denied)',
};

export const HEALTHY_ENV = appEnv({
  [APP_URL_VAR]: PROJECT_URL,
  [APP_KEY_VAR]: ANON_KEY,
});

export const CLEAN_SECRETS: SecretExposureProbe = {
  ok: true,
  exposures: [],
  storedPrivately: [],
};

export const dotenv = (vars: Record<string, string>) =>
  `${Object.entries(vars)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n')}\n`;

export function commandResult(stdout = ''): CommandResult {
  return { ok: true, exitCode: 0, stdout, stderr: '' };
}

export function failure(exitCode: number, output = ''): CommandResult {
  return { ok: false, exitCode, stdout: output, stderr: '' };
}

export function stderrFailure(exitCode: number, stderr: string): CommandResult {
  return { ok: false, exitCode, stdout: '', stderr };
}

export const KILLED: CommandResult = {
  ok: false,
  exitCode: null,
  stdout: '',
  stderr: '',
};

export const missingFile = (file: string) =>
  stderrFailure(1, `cat: ${file}: No such file or directory`);

export const crash = (message = 'sandbox gone') => {
  return (): CommandResult => {
    throw new Error(message);
  };
};

type Respond = CommandResult | (() => CommandResult);
export type Route = [match: string | RegExp, respond: Respond];

const findRoute = (routes: readonly Route[], command: string) =>
  routes.find(([match]) =>
    typeof match === 'string' ? command.includes(match) : match.test(command)
  );

const answer = (respond: Respond) =>
  typeof respond === 'function' ? respond() : respond;

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Answers each command with the first route whose matcher it satisfies, so a prepended route overrides a later one. */
export function fakeExec(
  routes: readonly Route[],
  fallback: CommandResult = failure(127, 'command not found')
) {
  const calls: string[] = [];
  const exec: ExecCtx['exec'] = async (command) => {
    calls.push(command);
    const route = findRoute(routes, command);
    return route === undefined ? fallback : answer(route[1]);
  };
  return { ctx: { exec } as ExecCtx, calls };
}

export const CONTROL_COMMAND = 'test -f supabase/config.toml';

export const controlRoute = (respond: Respond): Route => [
  CONTROL_COMMAND,
  respond,
];
export const grepRoute = (respond: Respond): Route => [/\bgrep\b/, respond];
export const envFilesRoute = (respond: Respond): Route => [/\bfind\b/, respond];
export const checkIgnoreRoute = (respond: Respond): Route => [
  /\bcheck-ignore\b/,
  respond,
];
export const anyCatRoute = (respond: Respond): Route => [/^cat\b/, respond];
export const catRoute = (file: string, respond: Respond): Route => [
  new RegExp(
    `^cat\\s+(?:--\\s+)?['"]?(?:\\./)?${escapeRegExp(file)}['"]?\\s*$`
  ),
  respond,
];
export const tokenEnvRoute = (respond: Respond): Route => [
  /test -n .*SUPABASE_ACCESS_TOKEN/,
  respond,
];
export const versionRoute = (respond: Respond): Route => [
  /supabase --version$/,
  respond,
];

const sandboxRoots: string[] = [];

export function removeWorkspaces() {
  for (const root of sandboxRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

type WorkspaceOptions = {
  env?: Record<string, string>;
  overrides?: readonly Route[];
};

/**
 * Runs commands with bash in a real temp copy of the seeded app (`local/`)
 * plus `files` (a `null` value deletes a seeded file); a stub `supabase` answers
 * `--version`, and git config is isolated so the user's global ignore rules
 * cannot change a `check-ignore` result.
 */
export function workspaceExec(
  files: Record<string, string | null> = {},
  options: WorkspaceOptions = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-api-keys-'));
  sandboxRoots.push(root);
  const dir = path.join(root, 'app');
  for (const sub of ['app', 'home', 'tmp', 'bin']) {
    fs.mkdirSync(path.join(root, sub));
  }
  const stub = path.join(root, 'bin', 'supabase');
  fs.writeFileSync(stub, '#!/bin/sh\necho 2.117.0\n');
  fs.chmodSync(stub, 0o755);
  fs.cpSync(path.join(import.meta.dirname, 'local'), dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    if (content === null) {
      fs.rmSync(target, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const calls: string[] = [];
  const exec: ExecCtx['exec'] = async (command) => {
    calls.push(command);
    const route = findRoute(options.overrides ?? [], command);
    if (route !== undefined) return answer(route[1]);
    const run = spawnSync('bash', ['-c', command], {
      cwd: dir,
      env: {
        PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
        HOME: path.join(root, 'home'),
        TMPDIR: path.join(root, 'tmp'),
        GIT_CONFIG_NOSYSTEM: '1',
        ...options.env,
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    return {
      ok: run.status === 0,
      exitCode: run.status,
      stdout: run.stdout ?? '',
      stderr: run.stderr ?? '',
    };
  };
  return { ctx: { exec } as ExecCtx, dir, calls };
}

export function shellCall(command: string): ToolCallRecord {
  return {
    tool: { kind: 'other', toolName: 'shell' },
    body: { command },
    command,
    result: '',
    ts: 0,
  };
}
