// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-functions-002-deploy-and-call
import type {
  CommandResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  findSupabaseInvocations,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { type DeploymentProbe, NO_HOSTED_PROJECT } from './hosted.js';
import {
  checkMetrics,
  countCliCommands,
  deployFlags,
  readCliFacts,
} from './metrics.js';

const MARKER: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'beta',
  cliVersion: '2.0.0',
  docker: 'available',
  sessionStartedMs: 1_000,
};

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

const ctx: Pick<LocalStackEvalContext, 'exec'> = {
  exec: async (command) =>
    command.endsWith('supabase --version')
      ? commandResult('2.0.0\n')
      : commandResult('', false),
};

const movedCtx: Pick<LocalStackEvalContext, 'exec'> = {
  exec: async (command) =>
    command.startsWith('/usr/bin/supabase')
      ? commandResult('2.0.0\n')
      : commandResult('2.2.0\n'),
};

const DEPLOYED: DeploymentProbe = {
  ok: true,
  deployed: { status: 'ACTIVE', verifyJwt: true, version: 3 },
};
const NOT_DEPLOYED: DeploymentProbe = { ok: true, deployed: null };
const UNAVAILABLE: DeploymentProbe = { ok: false, notes: NO_HOSTED_PROJECT };

const metricsOf = (check: { notes?: string }) =>
  JSON.parse(check.notes ?? '{}');

const countOf = (commands: string[]) =>
  countCliCommands(findSupabaseInvocations(commands));

const flagsOf = (commands: string[]) =>
  deployFlags(findSupabaseInvocations(commands));

const total = (counts: Record<string, number>) =>
  Object.values(counts).reduce((sum, n) => sum + n, 0);

describe('countCliCommands', () => {
  it('counts each deploy-journey subcommand under its own key', () => {
    const counts = countOf([
      'supabase functions deploy',
      'supabase functions deploy shipping-quote --use-api',
      'supabase functions serve',
      'supabase functions list',
      'supabase functions new shipping-quote',
      'supabase functions download shipping-quote',
      'supabase link --project-ref abcdefghijklmnopqrst',
      'supabase login --token sbp_x',
      'supabase projects list',
      'supabase projects api-keys --project-ref abcdefghijklmnopqrst',
      'supabase secrets list',
    ]);
    expect(counts).toEqual({
      'functions deploy': 2,
      'functions serve': 1,
      'functions list': 1,
      'functions new': 1,
      'functions download': 1,
      link: 1,
      login: 1,
      'projects list': 1,
      'projects api-keys': 1,
      secrets: 1,
    });
  });

  it('files every secrets subcommand under secrets', () => {
    const counts = countOf([
      'supabase secrets set WEATHER_KEY=abc',
      'supabase secrets list',
      'supabase secrets unset WEATHER_KEY',
    ]);
    expect(counts).toEqual({ secrets: 3 });
  });

  it('files every other subcommand under other', () => {
    const counts = countOf([
      'supabase functions delete shipping-quote',
      'supabase functions',
      'supabase projects create demo',
      'supabase start',
      'supabase db push',
      'supabase migration list',
      'supabase stack list',
      'supabase',
    ]);
    expect(counts).toEqual({ other: 8 });
  });

  it.each([
    ['supabase --workdir app functions deploy', 'functions deploy'],
    ['supabase --workdir=app functions deploy', 'functions deploy'],
    ['supabase --profile staging functions deploy', 'functions deploy'],
    ['supabase --network-id net functions deploy', 'functions deploy'],
    ['supabase -o json projects list', 'projects list'],
    ['supabase --output json projects list', 'projects list'],
    ['supabase --output-format json projects list', 'projects list'],
    ['supabase --dns-resolver https functions deploy', 'functions deploy'],
    ['supabase --log-level debug functions deploy', 'functions deploy'],
    ['supabase --agent claude functions deploy', 'functions deploy'],
    [
      'supabase functions --project-ref abcdefghijklmnopqrst deploy',
      'functions deploy',
    ],
    [
      'supabase functions deploy --project-ref abcdefghijklmnopqrst',
      'functions deploy',
    ],
    [
      'supabase functions deploy --project-ref abcdefghijklmnopqrst shipping-quote',
      'functions deploy',
    ],
    [
      'supabase functions deploy --import-map ./import_map.json',
      'functions deploy',
    ],
    ['supabase functions deploy -j 4 shipping-quote', 'functions deploy'],
    ['supabase functions deploy --jobs 4', 'functions deploy'],
    [
      'supabase projects --project-ref abcdefghijklmnopqrst api-keys',
      'projects api-keys',
    ],
    ['supabase -o env projects api-keys', 'projects api-keys'],
    ['supabase --workdir app', 'other'],
    ['supabase -j 4', 'other'],
  ])('keys %s as %s', (command, key) => {
    expect(countOf([command])).toEqual({ [key]: 1 });
  });

  it('ignores boolean flags when keying a command', () => {
    expect(
      countOf([
        'supabase --debug functions deploy',
        'supabase functions deploy --use-api --no-verify-jwt',
        'supabase functions --debug serve',
      ])
    ).toEqual({ 'functions deploy': 2, 'functions serve': 1 });
  });

  it('does not count --help invocations or commands that are not the supabase CLI', () => {
    expect(
      total(
        countOf([
          'supabase functions deploy --help',
          'supabase projects list -h',
          'curl -s https://abcdefghijklmnopqrst.supabase.co/functions/v1/shipping-quote',
          'echo supabase functions deploy',
          'ls supabase/functions',
        ])
      )
    ).toBe(0);
  });

  it('counts a command run through a shell wrapper and chained commands separately', () => {
    const counts = countOf([
      "bash -lc 'supabase functions deploy'",
      'supabase link --project-ref abcdefghijklmnopqrst && supabase functions deploy',
    ]);
    expect(counts).toEqual({ 'functions deploy': 2, link: 1 });
  });

  it('returns no counts when there are no invocations', () => {
    expect(countCliCommands([])).toEqual({});
  });
});

describe('deployFlags', () => {
  it('counts each tracked flag on a functions deploy', () => {
    expect(
      flagsOf([
        'supabase functions deploy shipping-quote --use-api --project-ref abcdefghijklmnopqrst',
      ])
    ).toEqual({ '--use-api': 1, '--project-ref': 1 });
  });

  it('counts every tracked flag', () => {
    expect(
      flagsOf([
        'supabase functions deploy --use-api --use-docker --no-verify-jwt --project-ref abcdefghijklmnopqrst --prune',
      ])
    ).toEqual({
      '--use-api': 1,
      '--use-docker': 1,
      '--no-verify-jwt': 1,
      '--project-ref': 1,
      '--prune': 1,
    });
  });

  it('counts the flag=value form of a flag', () => {
    expect(
      flagsOf(['supabase functions deploy --project-ref=abcdefghijklmnopqrst'])
    ).toEqual({ '--project-ref': 1 });
  });

  it('counts a flag once per invocation that carries it', () => {
    expect(
      flagsOf([
        'supabase functions deploy --use-api',
        'supabase functions deploy shipping-quote --use-api --no-verify-jwt',
        'supabase functions deploy',
      ])
    ).toEqual({ '--use-api': 2, '--no-verify-jwt': 1 });
  });

  it('counts the flags of a deploy that follows global value flags', () => {
    expect(
      flagsOf([
        'supabase --workdir app functions deploy --use-api',
        'supabase -o json functions deploy --no-verify-jwt',
      ])
    ).toEqual({ '--use-api': 1, '--no-verify-jwt': 1 });
  });

  it('counts the flags of a deploy chained after a link', () => {
    expect(
      flagsOf([
        'supabase link --project-ref abcdefghijklmnopqrst && supabase functions deploy --use-api',
      ])
    ).toEqual({ '--use-api': 1 });
  });

  it('ignores the same flags on other subcommands', () => {
    expect(
      flagsOf([
        'supabase link --project-ref abcdefghijklmnopqrst',
        'supabase projects api-keys --project-ref abcdefghijklmnopqrst',
        'supabase functions serve --no-verify-jwt',
        'supabase functions list --project-ref abcdefghijklmnopqrst',
        'supabase functions download shipping-quote --use-api',
      ])
    ).toEqual({});
  });

  it('ignores flags the journey does not track', () => {
    expect(
      flagsOf(['supabase functions deploy --debug --import-map ./map.json'])
    ).toEqual({});
  });

  it('returns nothing for a deploy without flags and for no invocations', () => {
    expect(flagsOf(['supabase functions deploy'])).toEqual({});
    expect(deployFlags([])).toEqual({});
  });

  it('does not count a deploy that only asked for help', () => {
    expect(flagsOf(['supabase functions deploy --help --use-api'])).toEqual({});
  });
});

describe('readCliFacts', () => {
  it('reads the staged CLI version and no override for a plain run', async () => {
    const invocations = findSupabaseInvocations(['supabase functions deploy']);
    expect(await readCliFacts(ctx, MARKER, invocations)).toEqual({
      versions: { cliVersion: '2.0.0' },
      cliOverride: [],
    });
  });

  it('reports a version-swapping runner and a PATH version that moved', async () => {
    const invocations = findSupabaseInvocations([
      'npx --yes supabase@2.1.0 functions deploy',
    ]);
    expect(await readCliFacts(movedCtx, MARKER, invocations)).toEqual({
      versions: { cliVersion: '2.0.0', cliVersionAfterRun: '2.2.0' },
      cliOverride: ['npx --yes supabase@2.1.0'],
    });
  });

  it('reports nulls when the sandbox cannot be read', async () => {
    const failing: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async () => {
        throw new Error('sandbox gone');
      },
    };
    expect(await readCliFacts(failing, undefined, [])).toEqual({
      versions: { cliVersion: null },
      cliOverride: [],
    });
  });
});

describe('checkMetrics', () => {
  const commands = [
    'supabase login --token sbp_x',
    'supabase link --project-ref abcdefghijklmnopqrst',
    'supabase functions deploy --use-api --project-ref abcdefghijklmnopqrst',
    'supabase projects api-keys',
    'curl -s https://abcdefghijklmnopqrst.supabase.co/functions/v1/shipping-quote',
    'sudo apt-get install docker.io',
  ];

  it('reports every field and always passes', async () => {
    const invocations = findSupabaseInvocations(commands);
    const check = await checkMetrics(MARKER, {
      commands,
      invocations,
      hosted: true,
      deployment: DEPLOYED,
      cli: await readCliFacts(ctx, MARKER, invocations),
    });
    expect(check).toMatchObject({ name: 'metrics', passed: true });
    const metrics = metricsOf(check);
    expect(Object.keys(metrics).sort()).toEqual([
      'channel',
      'cliCommands',
      'cliDetours',
      'cliOverride',
      'cliVersion',
      'deployFlags',
      'deployedStatus',
      'deployedVerifyJwt',
      'hostedProject',
    ]);
    expect(metrics).toEqual({
      cliVersion: '2.0.0',
      cliOverride: [],
      channel: 'beta',
      hostedProject: true,
      deployedStatus: 'ACTIVE',
      deployedVerifyJwt: true,
      cliCommands: {
        login: 1,
        link: 1,
        'functions deploy': 1,
        'projects api-keys': 1,
      },
      deployFlags: { '--use-api': 1, '--project-ref': 1 },
      cliDetours: 1,
    });
  });

  it('reports a deployed function with JWT verification off as false, not null', async () => {
    const check = await checkMetrics(MARKER, {
      commands: [],
      invocations: [],
      hosted: true,
      deployment: {
        ok: true,
        deployed: { status: 'ACTIVE', verifyJwt: false, version: 1 },
      },
      cli: await readCliFacts(ctx, MARKER, []),
    });
    expect(metricsOf(check)).toMatchObject({
      deployedStatus: 'ACTIVE',
      deployedVerifyJwt: false,
    });
  });

  it('reports the status of a function that is not ACTIVE', async () => {
    const check = await checkMetrics(MARKER, {
      commands: [],
      invocations: [],
      hosted: true,
      deployment: {
        ok: true,
        deployed: { status: 'THROTTLED', verifyJwt: true, version: 1 },
      },
      cli: await readCliFacts(ctx, MARKER, []),
    });
    expect(metricsOf(check)).toMatchObject({ deployedStatus: 'THROTTLED' });
  });

  it('reports null JWT verification when the API did not report it', async () => {
    const check = await checkMetrics(MARKER, {
      commands: [],
      invocations: [],
      hosted: true,
      deployment: {
        ok: true,
        deployed: { status: 'ACTIVE', verifyJwt: undefined, version: 1 },
      },
      cli: await readCliFacts(ctx, MARKER, []),
    });
    expect(metricsOf(check)).toMatchObject({
      deployedStatus: 'ACTIVE',
      deployedVerifyJwt: null,
    });
  });

  it.each([
    ['a function that was never deployed', NOT_DEPLOYED],
    ['a deployment that could not be read', UNAVAILABLE],
  ])(
    'reports null status and JWT setting for %s',
    async (_label, deployment) => {
      const check = await checkMetrics(MARKER, {
        commands: [],
        invocations: [],
        hosted: true,
        deployment,
        cli: await readCliFacts(ctx, MARKER, []),
      });
      expect(metricsOf(check)).toMatchObject({
        hostedProject: true,
        deployedStatus: null,
        deployedVerifyJwt: null,
      });
    }
  );

  it('reports nulls instead of failing when nothing could be read', async () => {
    const failing: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async () => {
        throw new Error('sandbox gone');
      },
    };
    const check = await checkMetrics(undefined, {
      commands: [],
      invocations: [],
      hosted: false,
      deployment: UNAVAILABLE,
      cli: await readCliFacts(failing, undefined, []),
    });
    expect(check.passed).toBe(true);
    expect(metricsOf(check)).toMatchObject({
      cliVersion: null,
      channel: 'pinned',
      hostedProject: false,
      deployedStatus: null,
      deployedVerifyJwt: null,
      cliCommands: {},
      deployFlags: {},
      cliDetours: 0,
    });
  });

  it('reports a PATH version that moved and the override runner', async () => {
    const runnerCommands = ['npx --yes supabase@2.1.0 functions deploy'];
    const invocations = findSupabaseInvocations(runnerCommands);
    const check = await checkMetrics(MARKER, {
      commands: runnerCommands,
      invocations,
      hosted: true,
      deployment: DEPLOYED,
      cli: await readCliFacts(movedCtx, MARKER, invocations),
    });
    expect(metricsOf(check)).toMatchObject({
      cliVersion: '2.0.0',
      cliVersionAfterRun: '2.2.0',
      cliOverride: ['npx --yes supabase@2.1.0'],
    });
  });

  it('omits cliVersionAfterRun when the PATH version did not move', async () => {
    const check = await checkMetrics(MARKER, {
      commands: [],
      invocations: [],
      hosted: true,
      deployment: DEPLOYED,
      cli: await readCliFacts(ctx, MARKER, []),
    });
    expect(metricsOf(check)).not.toHaveProperty('cliVersionAfterRun');
  });

  it('keeps the other fields when the deployment cannot be read', async () => {
    const throwingDeployment = {
      ok: true,
      get deployed(): never {
        throw new Error('deployment unreadable');
      },
    } as unknown as DeploymentProbe;
    const invocations = findSupabaseInvocations(commands);
    const check = await checkMetrics(MARKER, {
      commands,
      invocations,
      hosted: true,
      deployment: throwingDeployment,
      cli: await readCliFacts(ctx, MARKER, invocations),
    });
    expect(check).toMatchObject({ name: 'metrics', passed: true });
    expect(metricsOf(check)).toMatchObject({
      cliVersion: '2.0.0',
      hostedProject: true,
      deployedStatus: null,
      deployedVerifyJwt: null,
      cliCommands: { 'functions deploy': 1 },
      deployFlags: { '--use-api': 1 },
      cliDetours: 1,
    });
  });

  it('keeps the other fields when the invocations cannot be counted', async () => {
    const check = await checkMetrics(MARKER, {
      commands,
      invocations: [null] as unknown as SupabaseInvocation[],
      hosted: true,
      deployment: DEPLOYED,
      cli: await readCliFacts(ctx, MARKER, []),
    });
    expect(check.passed).toBe(true);
    expect(metricsOf(check)).toMatchObject({
      cliVersion: '2.0.0',
      deployedStatus: 'ACTIVE',
      cliCommands: null,
      deployFlags: null,
      cliDetours: 1,
    });
  });

  it('keeps the other fields when the commands cannot be scanned', async () => {
    const check = await checkMetrics(MARKER, {
      commands: [undefined] as unknown as string[],
      invocations: [],
      hosted: true,
      deployment: DEPLOYED,
      cli: await readCliFacts(ctx, MARKER, []),
    });
    expect(check.passed).toBe(true);
    expect(metricsOf(check)).toMatchObject({
      cliVersion: '2.0.0',
      hostedProject: true,
      deployedStatus: 'ACTIVE',
      cliDetours: null,
    });
  });
});
