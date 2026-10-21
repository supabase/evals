// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-functions-003-set-and-list-secrets
import { createHash } from 'node:crypto';
import type {
  CommandResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
  TranscriptPart,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  findSupabaseInvocations,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { NO_HOSTED_PROJECT, type SecretsProbe } from './hosted.js';
import {
  checkMetrics,
  countCliCommands,
  readCliFacts,
  setForms,
} from './metrics.js';
import { DEVELOPMENT_VALUES, PRODUCTION_VALUES, SECRET_NAMES } from './seed.js';

const REF = 'abcdefghijklmnopqrst';
const CODEX_MARKER = '[REDACTED_SECRET]';

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

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');

const PRODUCTION_PROBE: SecretsProbe = {
  ok: true,
  secrets: SECRET_NAMES.map((name) => ({
    name,
    value: digest(PRODUCTION_VALUES[name]),
  })),
};

const UNAVAILABLE: SecretsProbe = { ok: false, notes: NO_HOSTED_PROJECT };

const metricsOf = (check: { notes?: string }) =>
  JSON.parse(check.notes ?? '{}');

const countOf = (commands: string[]) =>
  countCliCommands(findSupabaseInvocations(commands));

const formsOf = (commands: string[]) =>
  setForms(findSupabaseInvocations(commands));

const total = (counts: Record<string, number>) =>
  Object.values(counts).reduce((sum, n) => sum + n, 0);

type Facts = Parameters<typeof checkMetrics>[1];

async function facts(overrides: Partial<Facts> = {}): Promise<Facts> {
  return {
    commands: [],
    invocations: [],
    hosted: true,
    secrets: PRODUCTION_PROBE,
    cli: await readCliFacts(ctx, MARKER, []),
    transcript: [],
    ...overrides,
  };
}

const shellPart = (command: string, output: string): TranscriptPart => ({
  type: 'tool_call',
  name: 'shell',
  input: { command },
  output,
});

describe('countCliCommands', () => {
  it('counts each journey subcommand under its own key and files the rest under other', () => {
    expect(
      countOf([
        'supabase secrets set --env-file supabase/functions/.env.production',
        'supabase secrets set RESEND_API_KEY=abc',
        'supabase secrets list',
        'supabase secrets unset RESEND_API_KEY',
        `supabase link --project-ref ${REF}`,
        'supabase login --token sbp_x',
        'supabase projects list',
        'supabase functions deploy',
        'supabase start',
      ])
    ).toEqual({
      'secrets set': 2,
      'secrets list': 1,
      'secrets unset': 1,
      link: 1,
      login: 1,
      'projects list': 1,
      other: 2,
    });
  });

  it('files a bare secrets command and an unknown secrets verb under other', () => {
    expect(
      countOf(['supabase secrets', 'supabase secrets get RESEND_API_KEY'])
    ).toEqual({ other: 2 });
  });

  it.each([
    ['supabase --workdir app secrets list', 'secrets list'],
    ['supabase --workdir=app secrets list', 'secrets list'],
    ['supabase --profile staging secrets set A=b', 'secrets set'],
    ['supabase -o json secrets list', 'secrets list'],
    ['supabase --output json secrets list', 'secrets list'],
    ['supabase --output-format json secrets list', 'secrets list'],
    [`supabase --project-ref ${REF} secrets list`, 'secrets list'],
    [`supabase --project-ref=${REF} secrets list`, 'secrets list'],
    [`supabase secrets --project-ref ${REF} list`, 'secrets list'],
    [`supabase secrets list --project-ref ${REF}`, 'secrets list'],
    [
      `supabase secrets set --project-ref ${REF} --env-file .env.production`,
      'secrets set',
    ],
    ['supabase --debug secrets unset A', 'secrets unset'],
    ['supabase -o json projects list', 'projects list'],
    ['supabase --workdir app', 'other'],
  ])('keys %s as %s', (command, key) => {
    expect(countOf([command])).toEqual({ [key]: 1 });
  });

  it('does not count --help invocations or commands that are not the supabase CLI', () => {
    expect(
      total(
        countOf([
          'supabase secrets set --help',
          'supabase secrets list -h',
          'echo supabase secrets list',
          'grep -rn "secrets set" README.md',
          'ls supabase/functions',
        ])
      )
    ).toBe(0);
  });

  it('counts a command run through a shell wrapper and chained commands separately', () => {
    expect(
      countOf([
        "bash -lc 'supabase secrets list'",
        'supabase secrets set --env-file .env.production && supabase secrets list',
      ])
    ).toEqual({ 'secrets list': 2, 'secrets set': 1 });
  });

  it('counts a command run through npx', () => {
    expect(countOf(['npx supabase@latest secrets list'])).toEqual({
      'secrets list': 1,
    });
  });

  it('returns no counts when there are no invocations', () => {
    expect(countCliCommands([])).toEqual({});
  });

  it('only carries the keys that are non-zero', () => {
    expect(Object.keys(countOf(['supabase secrets list']))).toEqual([
      'secrets list',
    ]);
  });
});

describe('setForms', () => {
  it('counts a set that read an env file', () => {
    expect(
      formsOf([
        'supabase secrets set --env-file supabase/functions/.env.production',
      ])
    ).toEqual({ envFile: 1, inlinePairs: 0 });
  });

  it('counts the --env-file=path form', () => {
    expect(
      formsOf([
        'supabase secrets set --env-file=supabase/functions/.env.production',
      ])
    ).toEqual({ envFile: 1, inlinePairs: 0 });
  });

  it('counts a set that carried an inline NAME=VALUE pair', () => {
    expect(formsOf(['supabase secrets set RESEND_API_KEY=abc123'])).toEqual({
      envFile: 0,
      inlinePairs: 1,
    });
  });

  it('counts a set with several inline pairs once', () => {
    expect(
      formsOf(['supabase secrets set RESEND_API_KEY=abc STRIPE_SECRET_KEY=def'])
    ).toEqual({ envFile: 0, inlinePairs: 1 });
  });

  it('counts an inline pair whose value is a shell variable', () => {
    expect(
      formsOf(['supabase secrets set RESEND_API_KEY="$RESEND_API_KEY"'])
    ).toEqual({ envFile: 0, inlinePairs: 1 });
  });

  it('counts a set that carried both forms under both', () => {
    expect(
      formsOf(['supabase secrets set --env-file .env.production A=b'])
    ).toEqual({ envFile: 1, inlinePairs: 1 });
  });

  it('counts per invocation across several sets', () => {
    expect(
      formsOf([
        'supabase secrets set --env-file .env.production',
        'supabase secrets set --env-file .env.development',
        'supabase secrets set RESEND_API_KEY=abc',
      ])
    ).toEqual({ envFile: 2, inlinePairs: 1 });
  });

  it('does not take flag=value tokens for inline pairs', () => {
    expect(
      formsOf([
        `supabase secrets set --env-file=.env.production --project-ref=${REF}`,
      ])
    ).toEqual({ envFile: 1, inlinePairs: 0 });
  });

  it('does not take the value of a flag for an inline pair', () => {
    expect(
      formsOf([
        `supabase secrets set --project-ref ${REF} --env-file .env.production`,
      ])
    ).toEqual({ envFile: 1, inlinePairs: 0 });
  });

  it('does not take a bare name for an inline pair', () => {
    expect(formsOf(['supabase secrets set RESEND_API_KEY'])).toEqual({
      envFile: 0,
      inlinePairs: 0,
    });
  });

  it('counts a set with no arguments as neither form', () => {
    expect(formsOf(['supabase secrets set'])).toEqual({
      envFile: 0,
      inlinePairs: 0,
    });
  });

  it('ignores secrets list and unset invocations', () => {
    expect(
      formsOf([
        'supabase secrets list --env-file .env.production',
        'supabase secrets unset RESEND_API_KEY=abc',
      ])
    ).toEqual({ envFile: 0, inlinePairs: 0 });
  });

  it('reads the set past global flags before the verb', () => {
    expect(
      formsOf([
        `supabase --project-ref ${REF} secrets set --env-file .env.production`,
        'supabase -o json secrets set A=b',
      ])
    ).toEqual({ envFile: 1, inlinePairs: 1 });
  });

  it('reports zero of both for no invocations', () => {
    expect(setForms([])).toEqual({ envFile: 0, inlinePairs: 0 });
  });
});

describe('readCliFacts', () => {
  it('reads the staged CLI version and no override for a plain run', async () => {
    const invocations = findSupabaseInvocations(['supabase secrets list']);
    expect(await readCliFacts(ctx, MARKER, invocations)).toEqual({
      versions: { cliVersion: '2.0.0' },
      cliOverride: [],
    });
  });

  it('reports a version-swapping runner and a PATH version that moved', async () => {
    const invocations = findSupabaseInvocations([
      'npx --yes supabase@2.1.0 secrets list',
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
    `supabase link --project-ref ${REF}`,
    'supabase secrets set --env-file supabase/functions/.env.production',
    'supabase secrets set STRIPE_SECRET_KEY="$STRIPE_SECRET_KEY"',
    'supabase secrets list',
    'supabase projects list',
    'curl -s https://example.test',
    'sudo apt-get install docker.io',
  ];

  it('reports every field and always passes', async () => {
    const invocations = findSupabaseInvocations(commands);
    const check = await checkMetrics(
      MARKER,
      await facts({
        commands,
        invocations,
        secrets: {
          ok: true,
          secrets: [
            {
              name: 'RESEND_API_KEY',
              value: digest(PRODUCTION_VALUES.RESEND_API_KEY),
            },
            {
              name: 'STRIPE_SECRET_KEY',
              value: digest(DEVELOPMENT_VALUES.STRIPE_SECRET_KEY),
            },
          ],
        },
        cli: await readCliFacts(ctx, MARKER, invocations),
        transcript: [
          shellPart(
            'cat supabase/functions/.env.production',
            [
              `RESEND_API_KEY=${PRODUCTION_VALUES.RESEND_API_KEY}`,
              `STRIPE_SECRET_KEY=${PRODUCTION_VALUES.STRIPE_SECRET_KEY}`,
            ].join('\n')
          ),
          shellPart(
            'cat .env.local',
            `RESEND_API_KEY=${CODEX_MARKER}\nSTRIPE_SECRET_KEY=${CODEX_MARKER}`
          ),
        ],
      })
    );
    expect(check).toMatchObject({ name: 'metrics', passed: true });
    const metrics = metricsOf(check);
    expect(Object.keys(metrics).sort()).toEqual([
      'channel',
      'cliCommands',
      'cliDetours',
      'cliOverride',
      'cliVersion',
      'codexRedactions',
      'echoes',
      'hostedProject',
      'secretStates',
      'setForms',
    ]);
    expect(metrics).toEqual({
      cliVersion: '2.0.0',
      cliOverride: [],
      channel: 'beta',
      hostedProject: true,
      secretStates: {
        RESEND_API_KEY: 'production',
        STRIPE_SECRET_KEY: 'development',
        STRIPE_WEBHOOK_SECRET: 'missing',
      },
      cliCommands: {
        link: 1,
        'secrets set': 2,
        'secrets list': 1,
        'projects list': 1,
      },
      setForms: { envFile: 1, inlinePairs: 1 },
      echoes: 2,
      codexRedactions: 2,
      cliDetours: 1,
    });
  });

  it('reports null secret states when the probe failed', async () => {
    const check = await checkMetrics(
      MARKER,
      await facts({ hosted: false, secrets: UNAVAILABLE })
    );
    expect(metricsOf(check)).toMatchObject({
      hostedProject: false,
      secretStates: null,
    });
  });

  it('reports every name as production for a project that holds the production values', async () => {
    const check = await checkMetrics(MARKER, await facts());
    expect(metricsOf(check).secretStates).toEqual({
      RESEND_API_KEY: 'production',
      STRIPE_SECRET_KEY: 'production',
      STRIPE_WEBHOOK_SECRET: 'production',
    });
  });

  it('reports nulls instead of failing when nothing could be read', async () => {
    const failing: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async () => {
        throw new Error('sandbox gone');
      },
    };
    const check = await checkMetrics(
      undefined,
      await facts({
        hosted: false,
        secrets: UNAVAILABLE,
        cli: await readCliFacts(failing, undefined, []),
      })
    );
    expect(check.passed).toBe(true);
    expect(metricsOf(check)).toMatchObject({
      cliVersion: null,
      channel: 'pinned',
      hostedProject: false,
      secretStates: null,
      cliCommands: {},
      setForms: { envFile: 0, inlinePairs: 0 },
      echoes: 0,
      codexRedactions: 0,
      cliDetours: 0,
    });
  });

  it('reports a PATH version that moved and the override runner', async () => {
    const runnerCommands = ['npx --yes supabase@2.1.0 secrets list'];
    const invocations = findSupabaseInvocations(runnerCommands);
    const check = await checkMetrics(
      MARKER,
      await facts({
        commands: runnerCommands,
        invocations,
        cli: await readCliFacts(movedCtx, MARKER, invocations),
      })
    );
    expect(metricsOf(check)).toMatchObject({
      cliVersion: '2.0.0',
      cliVersionAfterRun: '2.2.0',
      cliOverride: ['npx --yes supabase@2.1.0'],
    });
  });

  it('omits cliVersionAfterRun when the PATH version did not move', async () => {
    const check = await checkMetrics(MARKER, await facts());
    expect(metricsOf(check)).not.toHaveProperty('cliVersionAfterRun');
  });

  it('reports the pinned channel when there is no marker', async () => {
    expect(
      metricsOf(await checkMetrics(undefined, await facts()))
    ).toMatchObject({ channel: 'pinned' });
  });

  it('keeps the other fields when the secrets cannot be read', async () => {
    const throwingProbe = {
      ok: true,
      get secrets(): never {
        throw new Error('secrets unreadable');
      },
    } as unknown as SecretsProbe;
    const invocations = findSupabaseInvocations(commands);
    const check = await checkMetrics(
      MARKER,
      await facts({
        commands,
        invocations,
        secrets: throwingProbe,
        cli: await readCliFacts(ctx, MARKER, invocations),
      })
    );
    expect(check).toMatchObject({ name: 'metrics', passed: true });
    expect(metricsOf(check)).toMatchObject({
      cliVersion: '2.0.0',
      hostedProject: true,
      secretStates: null,
      cliCommands: { 'secrets set': 2 },
      setForms: { envFile: 1, inlinePairs: 1 },
      cliDetours: 1,
    });
  });

  it('keeps the other fields when the invocations cannot be counted', async () => {
    const check = await checkMetrics(
      MARKER,
      await facts({
        commands,
        invocations: [null] as unknown as SupabaseInvocation[],
      })
    );
    expect(check.passed).toBe(true);
    expect(metricsOf(check)).toMatchObject({
      cliVersion: '2.0.0',
      secretStates: {
        RESEND_API_KEY: 'production',
        STRIPE_SECRET_KEY: 'production',
        STRIPE_WEBHOOK_SECRET: 'production',
      },
      cliCommands: null,
      setForms: null,
      cliDetours: 1,
    });
  });

  it('keeps the other fields when the commands cannot be scanned', async () => {
    const check = await checkMetrics(
      MARKER,
      await facts({ commands: [undefined] as unknown as string[] })
    );
    expect(check.passed).toBe(true);
    expect(metricsOf(check)).toMatchObject({
      cliVersion: '2.0.0',
      hostedProject: true,
      cliDetours: null,
    });
  });

  it('keeps the other fields when the transcript cannot be scanned', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const check = await checkMetrics(
      MARKER,
      await facts({
        commands,
        invocations: findSupabaseInvocations(commands),
        transcript: [
          { type: 'tool_call', name: 'shell', input: circular, output: '' },
        ],
      })
    );
    expect(check.passed).toBe(true);
    expect(metricsOf(check)).toMatchObject({
      cliVersion: '2.0.0',
      echoes: null,
      cliCommands: { 'secrets set': 2 },
      cliDetours: 1,
    });
  });

  it('never puts a seeded value in the metrics, however many the run leaked', async () => {
    const leaky = [
      `supabase secrets set RESEND_API_KEY=${PRODUCTION_VALUES.RESEND_API_KEY}`,
      `supabase secrets set STRIPE_SECRET_KEY=${DEVELOPMENT_VALUES.STRIPE_SECRET_KEY}`,
    ];
    const check = await checkMetrics(
      MARKER,
      await facts({
        commands: leaky,
        invocations: findSupabaseInvocations(leaky),
        transcript: [
          shellPart(leaky[0], PRODUCTION_VALUES.RESEND_API_KEY),
          {
            type: 'message',
            role: 'assistant',
            content: Object.values(PRODUCTION_VALUES).join(' '),
          },
        ],
      })
    );
    const notes = check.notes ?? '';
    expect(metricsOf(check).echoes).toBeGreaterThan(0);
    for (const value of [
      ...Object.values(PRODUCTION_VALUES),
      ...Object.values(DEVELOPMENT_VALUES),
    ]) {
      expect(notes).not.toContain(value);
    }
  });
});
