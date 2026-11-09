// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-cli-002-use-project-api-keys
import type { LocalStackEnvironmentMarker } from '@supabase-evals/core';
import { afterAll, describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import {
  ANON_KEY,
  APP_KEY_VAR,
  APP_URL_VAR,
  appEnv,
  CLEAN_SECRETS,
  commandResult,
  crash,
  ENV_FAILED,
  expectNoKeyValues,
  failure,
  fakeExec,
  HOSTED_ABSENT,
  HOSTED_OK,
  HOSTED_REF,
  KILLED,
  LOCAL_ANON_KEY,
  LOCAL_URL,
  NO_ENV,
  PROJECT_URL,
  PUBLISHABLE_KEY,
  removeWorkspaces,
  SECRET_KEY,
  SERVICE_ROLE_KEY,
  stderrFailure,
  tokenEnvRoute,
  workspaceExec,
} from './fixtures.js';
import {
  type ApiKeyCounts,
  checkMetrics,
  countApiKeyInvocations,
  readTokenInEnvironment,
} from './metrics.js';

afterAll(removeWorkspaces);

const MARKER: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'beta',
  cliVersion: '2.117.0',
  docker: 'available',
  sessionStartedMs: 1_000,
};

const ZERO_COUNTS: ApiKeyCounts = {
  projectsList: 0,
  projectsApiKeys: 0,
  projectsApiKeysReveal: 0,
  link: 0,
  login: 0,
  bootstrap: 0,
};

const metricsOf = (check: { notes?: string }) =>
  JSON.parse(check.notes ?? '{}') as Record<string, unknown>;

describe('countApiKeyInvocations', () => {
  const count = (...commands: string[]) =>
    countApiKeyInvocations(findSupabaseInvocations(commands));

  it('counts nothing when no supabase command ran', () => {
    expect(count()).toEqual(ZERO_COUNTS);
    expect(count('ls -la', 'cat .env.local')).toEqual(ZERO_COUNTS);
  });

  it.each([
    'supabase projects list',
    'supabase projects ls',
    'supabase projects list -o json',
  ])('counts %s as a projects list', (command) => {
    expect(count(command)).toEqual({ ...ZERO_COUNTS, projectsList: 1 });
  });

  it.each([
    `supabase projects api-keys --project-ref ${HOSTED_REF}`,
    `supabase projects api-keys --project-ref=${HOSTED_REF}`,
    'supabase projects api-keys -o env',
    'npx supabase projects api-keys',
    'supabase projects api-keys -o env | grep ANON',
  ])('counts %s as an api-keys call without reveal', (command) => {
    expect(count(command)).toEqual({ ...ZERO_COUNTS, projectsApiKeys: 1 });
  });

  it.each([
    `supabase projects api-keys --project-ref ${HOSTED_REF} --reveal`,
    'supabase projects api-keys --reveal -o env',
    'npx supabase projects api-keys --reveal',
    'supabase projects api-keys --reveal=true',
    'supabase projects api-keys --reveal=TRUE',
    'supabase projects api-keys --reveal=1',
    'supabase projects api-keys --reveal=t',
  ])('counts %s as an api-keys call with reveal', (command) => {
    expect(count(command)).toEqual({
      ...ZERO_COUNTS,
      projectsApiKeys: 1,
      projectsApiKeysReveal: 1,
    });
  });

  it.each([
    'supabase projects api-keys --reveal=false',
    'supabase projects api-keys --reveal=0',
    'supabase projects api-keys --reveal=f',
    'supabase projects api-keys --reveal-all',
  ])('counts %s as an api-keys call without reveal', (command) => {
    expect(count(command)).toEqual({ ...ZERO_COUNTS, projectsApiKeys: 1 });
  });

  it.each([
    [`supabase link --project-ref ${HOSTED_REF}`, { link: 1 }],
    [`supabase link ${HOSTED_REF}`, { link: 1 }],
    ['supabase login', { login: 1 }],
    ['supabase login --token "$SUPABASE_ACCESS_TOKEN"', { login: 1 }],
    ['supabase bootstrap', { bootstrap: 1 }],
    ['supabase bootstrap nextjs', { bootstrap: 1 }],
  ])('counts %s', (command, expected) => {
    expect(count(command)).toEqual({ ...ZERO_COUNTS, ...expected });
  });

  it.each([
    'supabase projects create demo',
    'supabase secrets list',
    'supabase functions list',
    'supabase branches list',
    'supabase start',
    'supabase db push',
  ])('does not count %s', (command) => {
    expect(count(command)).toEqual(ZERO_COUNTS);
  });

  it('counts every invocation of a chained command and across commands', () => {
    expect(
      count(
        `supabase login --token "$SUPABASE_ACCESS_TOKEN" && supabase projects list && supabase link --project-ref ${HOSTED_REF}`,
        `supabase projects api-keys --project-ref ${HOSTED_REF}`,
        `supabase projects api-keys --project-ref ${HOSTED_REF} --reveal -o env`,
        'supabase projects ls',
        'supabase bootstrap'
      )
    ).toEqual({
      projectsList: 2,
      projectsApiKeys: 2,
      projectsApiKeysReveal: 1,
      link: 1,
      login: 1,
      bootstrap: 1,
    });
  });
});

describe('readTokenInEnvironment', () => {
  it.each([
    [0, true],
    [1, false],
  ])('reports %s from the probe as %s', async (exitCode, expected) => {
    const { ctx } = fakeExec([
      tokenEnvRoute(exitCode === 0 ? commandResult() : failure(exitCode)),
    ]);

    expect(await readTokenInEnvironment(ctx)).toBe(expected);
  });

  it.each([
    ['exits 2', stderrFailure(2, 'test: bad expression')],
    ['is killed', KILLED],
    ['throws', crash('sandbox gone')],
  ])('reports null for a probe that %s', async (_, result) => {
    const { ctx } = fakeExec([tokenEnvRoute(result)]);

    expect(await readTokenInEnvironment(ctx)).toBeNull();
  });

  it.each([
    [
      'a token is exported',
      { SUPABASE_ACCESS_TOKEN: 'sbp_evals_fixture_do_not_use' },
      true,
    ],
    ['the token is empty', { SUPABASE_ACCESS_TOKEN: '' }, false],
    ['the token is not exported', {}, false],
  ])('reads %s correctly in a real shell', async (_, env, expected) => {
    const { ctx } = workspaceExec({}, { env });

    expect(await readTokenInEnvironment(ctx)).toBe(expected);
  });
});

describe('checkMetrics', () => {
  const COMMANDS = [
    'supabase projects list',
    `supabase projects api-keys --project-ref ${HOSTED_REF} --reveal`,
    "printf 'VITE_SUPABASE_URL=...' > .env.local",
  ];

  const FACTS = {
    hosted: HOSTED_OK,
    env: appEnv({
      [APP_URL_VAR]: PROJECT_URL,
      [APP_KEY_VAR]: ANON_KEY,
    }),
    secrets: {
      ok: true as const,
      exposures: [],
      storedPrivately: ['SUPABASE_SERVICE_ROLE_KEY in .env.local'],
    },
    counts: {
      ...ZERO_COUNTS,
      projectsList: 1,
      projectsApiKeys: 1,
      projectsApiKeysReveal: 1,
    },
    tokenInEnvironment: true,
    cli: { cliVersion: '2.117.0' },
    commands: COMMANDS,
  };

  const BASELINE = {
    hostedProject: true,
    projectsList: 1,
    projectsApiKeys: 1,
    projectsApiKeysReveal: 1,
    link: 0,
    login: 0,
    bootstrap: 0,
    tokenInEnvironment: true,
    envFiles: ['.env.local'],
    urlHost: `${HOSTED_REF}.supabase.co`,
    keyKind: 'client',
    secretsStoredPrivately: 1,
    cliVersion: '2.117.0',
    runtime: 'local-stack',
    docker: 'available',
    commandCount: 3,
  };

  it('carries every documented field and passes', () => {
    const check = checkMetrics(MARKER, FACTS);

    expect(check).toMatchObject({ name: 'metrics', passed: true });
    expect(metricsOf(check)).toMatchObject(BASELINE);
  });

  it('reports the CLI version PATH resolved to after the run when it differs', () => {
    const check = checkMetrics(MARKER, {
      ...FACTS,
      cli: { cliVersion: '2.117.0', cliVersionAfterRun: '2.120.0' },
    });

    expect(metricsOf(check)).toMatchObject({
      cliVersion: '2.117.0',
      cliVersionAfterRun: '2.120.0',
    });
  });

  it('reports no runtime or docker without a marker and keeps the rest', () => {
    const metrics = metricsOf(checkMetrics(undefined, FACTS));

    expect(metrics.runtime ?? null).toBeNull();
    expect(metrics.docker ?? null).toBeNull();
    expect(metrics).toMatchObject({ hostedProject: true, commandCount: 3 });
  });

  it.each([
    ['unset', NO_ENV, 'unset'],
    [
      'the project client key',
      appEnv({ [APP_KEY_VAR]: PUBLISHABLE_KEY }),
      'client',
    ],
    [
      'the service_role key',
      appEnv({ [APP_KEY_VAR]: SERVICE_ROLE_KEY }),
      'secret',
    ],
    ['the sb_secret_ key', appEnv({ [APP_KEY_VAR]: SECRET_KEY }), 'secret'],
    ['a local stack key', appEnv({ [APP_KEY_VAR]: LOCAL_ANON_KEY }), 'other'],
  ])(
    'reports key kind for a config that holds %s, never the key itself',
    (_, env, kind) => {
      const check = checkMetrics(MARKER, { ...FACTS, env });

      expect(metricsOf(check).keyKind).toBe(kind);
      expectNoKeyValues(check.notes);
    }
  );

  it.each([
    ['the project URL', PROJECT_URL, `${HOSTED_REF}.supabase.co`],
    ['a local stack URL', LOCAL_URL, '127.0.0.1'],
    [
      'a URL carrying a path and a key',
      `${PROJECT_URL}/rest/v1?apikey=${SERVICE_ROLE_KEY}`,
      `${HOSTED_REF}.supabase.co`,
    ],
    ['a value that is not a URL', 'your-project-url', null],
    ['a key pasted into the URL variable', SERVICE_ROLE_KEY, null],
  ])(
    'reports the URL host for %s, never more than the host',
    (_, value, host) => {
      const check = checkMetrics(MARKER, {
        ...FACTS,
        env: appEnv({ [APP_URL_VAR]: value }),
      });

      expect(metricsOf(check).urlHost ?? null).toBe(host);
      expectNoKeyValues(check.notes);
    }
  );

  it('reports no URL host when the URL is unset', () => {
    expect(
      metricsOf(checkMetrics(MARKER, { ...FACTS, env: NO_ENV })).urlHost ?? null
    ).toBeNull();
  });

  it('keeps every other field when the env files could not be read', () => {
    const check = checkMetrics(MARKER, { ...FACTS, env: ENV_FAILED });
    const metrics = metricsOf(check);

    expect(check.passed).toBe(true);
    expect(metrics.envFiles ?? null).toBeNull();
    expect(metrics.urlHost ?? null).toBeNull();
    expect(metrics.keyKind ?? null).toBeNull();
    expect(metrics).toMatchObject({
      hostedProject: true,
      projectsList: 1,
      projectsApiKeys: 1,
      projectsApiKeysReveal: 1,
      tokenInEnvironment: true,
      secretsStoredPrivately: 1,
      cliVersion: '2.117.0',
      commandCount: 3,
    });
  });

  it('keeps every other field when the secret search could not run', () => {
    const check = checkMetrics(MARKER, {
      ...FACTS,
      secrets: { ok: false, notes: 'supabase/config.toml is missing' },
    });
    const metrics = metricsOf(check);

    expect(check.passed).toBe(true);
    expect(metrics.secretsStoredPrivately ?? null).toBeNull();
    expect(metrics).toMatchObject({
      hostedProject: true,
      projectsApiKeys: 1,
      envFiles: ['.env.local'],
      urlHost: `${HOSTED_REF}.supabase.co`,
      keyKind: 'client',
      commandCount: 3,
    });
  });

  it('reports no hosted project but still classifies what the config holds', () => {
    const metrics = metricsOf(
      checkMetrics(MARKER, { ...FACTS, hosted: HOSTED_ABSENT })
    );

    expect(metrics).toMatchObject({ hostedProject: false, keyKind: 'other' });
  });

  it('counts zero privately stored secrets for a clean search', () => {
    const metrics = metricsOf(
      checkMetrics(MARKER, { ...FACTS, secrets: CLEAN_SECRETS })
    );

    expect(metrics.secretsStoredPrivately).toBe(0);
  });

  it('passes with nulls and zeros when nothing worked', () => {
    const check = checkMetrics(undefined, {
      hosted: HOSTED_ABSENT,
      env: ENV_FAILED,
      secrets: { ok: false, notes: 'could not search' },
      counts: ZERO_COUNTS,
      tokenInEnvironment: null,
      cli: { cliVersion: null },
      commands: [],
    });

    expect(check).toMatchObject({ name: 'metrics', passed: true });
    expect(metricsOf(check)).toMatchObject({
      hostedProject: false,
      projectsList: 0,
      projectsApiKeys: 0,
      projectsApiKeysReveal: 0,
      link: 0,
      login: 0,
      bootstrap: 0,
      tokenInEnvironment: null,
      envFiles: null,
      urlHost: null,
      keyKind: null,
      secretsStoredPrivately: null,
      cliVersion: null,
      commandCount: 0,
    });
  });
});
