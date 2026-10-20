// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-cli-001-login-and-link
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  CommandResult,
  LocalStackEnvironmentMarker,
} from '@supabase-evals/core';
import { afterAll, describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import {
  commandResult,
  crash,
  FAKE_ACCESS_TOKEN,
  failure,
  fakeExec,
  HOSTED_ABSENT,
  HOSTED_OK,
  HOSTED_REF,
  type ExecCtx,
  persistedLoginRoute,
  stderrFailure,
  tokenEnvRoute,
} from './fixtures.js';
import {
  checkMetrics,
  countLoginLinkInvocations,
  readCredentialFacts,
  type LoginLinkCounts,
} from './metrics.js';

const MARKER: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'beta',
  cliVersion: '2.117.0',
  docker: 'available',
  sessionStartedMs: 1_000,
};

const ZERO_COUNTS: LoginLinkCounts = {
  login: 0,
  loginWithToken: 0,
  link: 0,
  unlink: 0,
  projectsList: 0,
};

const metricsOf = (check: { notes?: string }) =>
  JSON.parse(check.notes ?? '{}') as Record<string, unknown>;

describe('countLoginLinkInvocations', () => {
  const count = (...commands: string[]) =>
    countLoginLinkInvocations(findSupabaseInvocations(commands));

  it('counts nothing when no supabase command ran', () => {
    expect(count()).toEqual(ZERO_COUNTS);
  });

  it('counts a bare login as a login without a token flag', () => {
    expect(count('supabase login')).toEqual({ ...ZERO_COUNTS, login: 1 });
  });

  it('counts login --token as a login with a token', () => {
    expect(count('supabase login --token "$SUPABASE_ACCESS_TOKEN"')).toEqual({
      ...ZERO_COUNTS,
      login: 1,
      loginWithToken: 1,
    });
  });

  it('counts login --token=<token> as a login with a token', () => {
    expect(count(`supabase login --token=${FAKE_ACCESS_TOKEN}`)).toEqual({
      ...ZERO_COUNTS,
      login: 1,
      loginWithToken: 1,
    });
  });

  it('does not count a trailing bare --token as a login with a token', () => {
    expect(count('supabase login --token')).toEqual({
      ...ZERO_COUNTS,
      login: 1,
    });
  });

  it('counts a login fed the token on stdin as a login without a token flag', () => {
    expect(count('echo "$SUPABASE_ACCESS_TOKEN" | supabase login')).toEqual({
      ...ZERO_COUNTS,
      login: 1,
    });
  });

  it.each([
    'supabase projects list',
    'supabase projects ls',
    'supabase projects list -o json',
  ])('counts %s as a projects list', (command) => {
    expect(count(command)).toEqual({ ...ZERO_COUNTS, projectsList: 1 });
  });

  it('counts supabase link --project-ref through npx as a link', () => {
    expect(count(`npx supabase link --project-ref ${HOSTED_REF}`)).toEqual({
      ...ZERO_COUNTS,
      link: 1,
    });
  });

  it('counts supabase link with a positional ref as a link', () => {
    expect(count(`supabase link ${HOSTED_REF}`)).toEqual({
      ...ZERO_COUNTS,
      link: 1,
    });
  });

  it('counts unlink as an unlink, not a link', () => {
    expect(count('supabase unlink')).toEqual({ ...ZERO_COUNTS, unlink: 1 });
  });

  it('does not count other projects subcommands as a projects list', () => {
    expect(
      count(
        `supabase projects api-keys --project-ref ${HOSTED_REF}`,
        'supabase projects create demo'
      )
    ).toEqual(ZERO_COUNTS);
  });

  it('does not count another command group listing as a projects list', () => {
    expect(
      count(
        'supabase secrets list',
        'supabase functions list',
        'supabase branches list'
      )
    ).toEqual(ZERO_COUNTS);
  });

  it('does not count unrelated supabase commands', () => {
    expect(
      count('supabase start', 'supabase db push', 'supabase init')
    ).toEqual(ZERO_COUNTS);
  });

  it('counts every invocation of a chained command and across commands', () => {
    expect(
      count(
        `supabase login --token "$SUPABASE_ACCESS_TOKEN" && supabase link --project-ref ${HOSTED_REF}`,
        'supabase projects list',
        'supabase login',
        'supabase unlink',
        `supabase link ${HOSTED_REF}`
      )
    ).toEqual({
      login: 2,
      loginWithToken: 1,
      link: 2,
      unlink: 1,
      projectsList: 1,
    });
  });
});

describe('readCredentialFacts', () => {
  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])(
    'reports tokenInEnvironment=%s and persistedLogin=%s from the two probes',
    async (inEnv, persisted) => {
      const { ctx } = fakeExec([
        tokenEnvRoute(inEnv ? commandResult() : failure(1)),
        persistedLoginRoute(persisted ? commandResult() : failure(1)),
      ]);

      expect(await readCredentialFacts(ctx)).toEqual({
        tokenInEnvironment: inEnv,
        persistedLogin: persisted,
      });
    }
  );

  it.each([
    ['exits 2', stderrFailure(2, 'test: bad expression')],
    ['is killed', { ok: false, exitCode: null, stdout: '', stderr: '' }],
  ])('reports null for a probe that %s', async (_, result) => {
    const { ctx } = fakeExec([
      tokenEnvRoute(result),
      persistedLoginRoute(result),
    ]);

    expect(await readCredentialFacts(ctx)).toEqual({
      tokenInEnvironment: null,
      persistedLogin: null,
    });
  });

  it('reports null for the probe whose exec throws and keeps the other', async () => {
    const { ctx } = fakeExec([
      tokenEnvRoute(crash('sandbox gone')),
      persistedLoginRoute(commandResult()),
    ]);

    expect(await readCredentialFacts(ctx)).toEqual({
      tokenInEnvironment: null,
      persistedLogin: true,
    });
  });

  it('reports null for both when every exec throws', async () => {
    const { ctx } = fakeExec([
      tokenEnvRoute(crash()),
      persistedLoginRoute(crash()),
    ]);

    expect(await readCredentialFacts(ctx)).toEqual({
      tokenInEnvironment: null,
      persistedLogin: null,
    });
  });
});

describe('readCredentialFacts in a real shell', () => {
  const dirs: string[] = [];

  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  const tempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-login-creds-'));
    dirs.push(dir);
    return dir;
  };

  const shellWith = (env: Record<string, string>): ExecCtx => ({
    exec: async (command): Promise<CommandResult> => {
      const run = spawnSync('bash', ['-c', command], {
        env: { PATH: process.env.PATH ?? '', ...env },
        encoding: 'utf8',
      });
      return {
        ok: run.status === 0,
        exitCode: run.status,
        stdout: run.stdout,
        stderr: run.stderr,
      };
    },
  });

  const writeToken = (dir: string, content = `${FAKE_ACCESS_TOKEN}\n`) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'access-token'), content);
  };

  it('sees a token exported in the environment and no persisted login', async () => {
    const home = tempDir();

    expect(
      await readCredentialFacts(
        shellWith({ HOME: home, SUPABASE_ACCESS_TOKEN: FAKE_ACCESS_TOKEN })
      )
    ).toEqual({ tokenInEnvironment: true, persistedLogin: false });
  });

  it('treats an empty SUPABASE_ACCESS_TOKEN as absent', async () => {
    const home = tempDir();

    expect(
      await readCredentialFacts(
        shellWith({ HOME: home, SUPABASE_ACCESS_TOKEN: '' })
      )
    ).toEqual({ tokenInEnvironment: false, persistedLogin: false });
  });

  it('finds a persisted login under $HOME/.supabase when SUPABASE_HOME is unset', async () => {
    const home = tempDir();
    writeToken(path.join(home, '.supabase'));

    expect(await readCredentialFacts(shellWith({ HOME: home }))).toEqual({
      tokenInEnvironment: false,
      persistedLogin: true,
    });
  });

  it('treats an empty access-token file as no persisted login', async () => {
    const home = tempDir();
    writeToken(path.join(home, '.supabase'), '');

    expect(
      (await readCredentialFacts(shellWith({ HOME: home }))).persistedLogin
    ).toBe(false);
  });

  it('looks under SUPABASE_HOME instead of $HOME/.supabase when it is set', async () => {
    const home = tempDir();
    const relocated = tempDir();
    writeToken(relocated);

    const facts = await readCredentialFacts(
      shellWith({ HOME: home, SUPABASE_HOME: relocated })
    );

    expect(facts.persistedLogin).toBe(true);
  });

  it('does not fall back to $HOME/.supabase when SUPABASE_HOME points elsewhere', async () => {
    const home = tempDir();
    writeToken(path.join(home, '.supabase'));

    const facts = await readCredentialFacts(
      shellWith({ HOME: home, SUPABASE_HOME: tempDir() })
    );

    expect(facts.persistedLogin).toBe(false);
  });
});

describe('checkMetrics', () => {
  const COMMANDS = [
    'supabase login --token "$SUPABASE_ACCESS_TOKEN"',
    'supabase projects list',
    `supabase link --project-ref ${HOSTED_REF}`,
  ];

  const FACTS = {
    hosted: HOSTED_OK,
    link: { ok: true as const, ref: HOSTED_REF },
    probe: { exitCode: 0, output: 'NAME  DIGEST' },
    counts: {
      login: 1,
      loginWithToken: 1,
      link: 1,
      unlink: 0,
      projectsList: 1,
    },
    credentials: { tokenInEnvironment: true, persistedLogin: false },
    cli: { cliVersion: '2.117.0' },
    commands: COMMANDS,
  };

  const BASELINE = {
    hostedProject: true,
    workspaceProjectRef: HOSTED_REF,
    linkedCliExitCode: 0,
    login: 1,
    loginWithToken: 1,
    link: 1,
    unlink: 0,
    projectsList: 1,
    tokenInEnvironment: true,
    persistedLogin: false,
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

  it('reports no version after the run when PATH agreed', () => {
    const metrics = metricsOf(checkMetrics(MARKER, FACTS));

    expect(metrics.cliVersionAfterRun ?? null).toBeNull();
  });

  it('reports no runtime or docker without a marker', () => {
    const metrics = metricsOf(checkMetrics(undefined, FACTS));

    expect(metrics.runtime ?? null).toBeNull();
    expect(metrics.docker ?? null).toBeNull();
    expect(metrics).toMatchObject({
      hostedProject: true,
      commandCount: 3,
    });
  });

  it('passes with nulls and zeros when nothing worked', () => {
    const check = checkMetrics(undefined, {
      hosted: HOSTED_ABSENT,
      link: { ok: false, notes: 'supabase/.temp/project-ref is missing' },
      probe: { exitCode: null, output: 'sandbox gone' },
      counts: ZERO_COUNTS,
      credentials: { tokenInEnvironment: null, persistedLogin: null },
      cli: { cliVersion: null },
      commands: [],
    });

    expect(check).toMatchObject({ name: 'metrics', passed: true });
    expect(metricsOf(check)).toMatchObject({
      hostedProject: false,
      workspaceProjectRef: null,
      linkedCliExitCode: null,
      login: 0,
      loginWithToken: 0,
      link: 0,
      unlink: 0,
      projectsList: 0,
      tokenInEnvironment: null,
      persistedLogin: null,
      cliVersion: null,
      commandCount: 0,
    });
  });
});
