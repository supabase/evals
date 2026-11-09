// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-functions-004-download-edit-redeploy
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  CommandResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findSupabaseInvocations,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { type DeploymentProbe, NO_HOSTED_PROJECT } from './hosted.js';
import {
  checkMetrics,
  countCliCommands,
  deployFlags,
  downloadFlags,
  readCliFacts,
  readLocalSource,
} from './metrics.js';

const REF = 'abcdefghijklmnopqrst';

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
  deployed: { status: 'ACTIVE', verifyJwt: true, version: 2 },
};
const NOT_DEPLOYED: DeploymentProbe = { ok: true, deployed: null };
const UNAVAILABLE: DeploymentProbe = { ok: false, notes: NO_HOSTED_PROJECT };

const metricsOf = (check: { notes?: string }) =>
  JSON.parse(check.notes ?? '{}');

const countOf = (commands: string[]) =>
  countCliCommands(findSupabaseInvocations(commands));

const deployFlagsOf = (commands: string[]) =>
  deployFlags(findSupabaseInvocations(commands));

const downloadFlagsOf = (commands: string[]) =>
  downloadFlags(findSupabaseInvocations(commands));

const total = (counts: Record<string, number>) =>
  Object.values(counts).reduce((sum, n) => sum + n, 0);

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-metrics-'));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

describe('countCliCommands', () => {
  it('counts each journey subcommand under its own key', () => {
    const counts = countOf([
      'supabase functions download apply-promo',
      'supabase functions download apply-promo --use-api',
      'supabase functions deploy',
      'supabase functions deploy apply-promo --use-api',
      'supabase functions serve',
      'supabase functions list',
      'supabase functions new apply-promo',
      `supabase link --project-ref ${REF}`,
      'supabase login --token sbp_x',
      'supabase projects list',
      `supabase projects api-keys --project-ref ${REF}`,
      'supabase secrets list',
      'supabase start',
      'supabase status',
    ]);
    expect(counts).toEqual({
      'functions download': 2,
      'functions deploy': 2,
      'functions serve': 1,
      'functions list': 1,
      'functions new': 1,
      link: 1,
      login: 1,
      'projects list': 1,
      'projects api-keys': 1,
      secrets: 1,
      start: 1,
      status: 1,
    });
  });

  it('keeps functions download apart from functions deploy', () => {
    expect(
      countOf([
        'supabase functions download apply-promo',
        'supabase functions deploy apply-promo',
        'supabase functions deploy apply-promo',
      ])
    ).toEqual({ 'functions download': 1, 'functions deploy': 2 });
  });

  it('counts the local-stack commands start and status under their own keys, not other', () => {
    const counts = countOf([
      'supabase start',
      'supabase start -x gotrue,imgproxy',
      'supabase --workdir app start',
      'supabase status',
      'supabase status -o env',
      'supabase --debug status',
      'supabase stop',
    ]);
    expect(counts).toEqual({ start: 3, status: 3, other: 1 });
  });

  it('files every other subcommand under other', () => {
    const counts = countOf([
      'supabase functions delete apply-promo',
      'supabase functions',
      'supabase projects create demo',
      'supabase db push',
      'supabase migration list',
      'supabase stack list',
      'supabase stop',
      'supabase',
    ]);
    expect(counts).toEqual({ other: 8 });
  });

  it.each([
    ['supabase --workdir app functions download', 'functions download'],
    ['supabase --workdir app functions deploy', 'functions deploy'],
    ['supabase --profile staging functions download', 'functions download'],
    ['supabase -o json projects list', 'projects list'],
    ['supabase --output-format json projects list', 'projects list'],
    ['supabase --log-level debug functions download', 'functions download'],
    ['supabase --agent claude functions deploy', 'functions deploy'],
    [`supabase functions --project-ref ${REF} download`, 'functions download'],
    [
      `supabase functions download --project-ref ${REF} apply-promo`,
      'functions download',
    ],
    [
      `supabase functions download apply-promo --project-ref ${REF}`,
      'functions download',
    ],
    [
      `supabase functions deploy --project-ref ${REF} apply-promo`,
      'functions deploy',
    ],
    ['supabase functions download apply-promo -j 4', 'functions download'],
    ['supabase --workdir app', 'other'],
  ])('keys %s as %s', (command, key) => {
    expect(countOf([command])).toEqual({ [key]: 1 });
  });

  it.each([
    ['supabase functions download --remote apply-promo', 'functions download'],
    ['supabase functions download --remote', 'functions download'],
    [
      `supabase functions download --remote=${REF} apply-promo`,
      'functions download',
    ],
    ['supabase functions --remote download apply-promo', 'functions download'],
    [
      'supabase functions --remote=staging download apply-promo',
      'functions download',
    ],
    ['supabase functions deploy --remote apply-promo', 'functions deploy'],
    ['supabase functions deploy --remote', 'functions deploy'],
    [`supabase functions deploy --remote=${REF}`, 'functions deploy'],
    ['supabase functions --remote deploy', 'functions deploy'],
    ['supabase --remote functions download apply-promo', 'functions download'],
  ])(
    'keys %s as %s, because --remote takes an optional value and never swallows the next word',
    (command, key) => {
      expect(countOf([command])).toEqual({ [key]: 1 });
    }
  );

  it('ignores boolean flags when keying a command', () => {
    expect(
      countOf([
        'supabase --debug functions download',
        'supabase functions download apply-promo --use-api --legacy-bundle',
        'supabase functions deploy --use-api --no-verify-jwt',
        'supabase functions --debug serve',
      ])
    ).toEqual({
      'functions download': 2,
      'functions deploy': 1,
      'functions serve': 1,
    });
  });

  it('does not count --help invocations or commands that are not the supabase CLI', () => {
    expect(
      total(
        countOf([
          'supabase functions download --help',
          'supabase functions deploy --help',
          'supabase projects list -h',
          `curl -s https://${REF}.supabase.co/functions/v1/apply-promo`,
          'echo supabase functions download apply-promo',
          'ls supabase/functions',
        ])
      )
    ).toBe(0);
  });

  it('counts a command run through a shell wrapper and chained commands separately', () => {
    const counts = countOf([
      "bash -lc 'supabase functions download apply-promo'",
      `supabase link --project-ref ${REF} && supabase functions download apply-promo && supabase functions deploy`,
    ]);
    expect(counts).toEqual({
      'functions download': 2,
      'functions deploy': 1,
      link: 1,
    });
  });

  it('returns no counts when there are no invocations', () => {
    expect(countCliCommands([])).toEqual({});
  });
});

describe('downloadFlags', () => {
  it('counts each tracked flag on a functions download', () => {
    expect(
      downloadFlagsOf([
        `supabase functions download apply-promo --use-api --project-ref ${REF}`,
      ])
    ).toEqual({ '--use-api': 1, '--project-ref': 1 });
  });

  it('counts every tracked flag', () => {
    expect(
      downloadFlagsOf([
        `supabase functions download apply-promo --use-api --use-docker --legacy-bundle --project-ref ${REF} --remote`,
      ])
    ).toEqual({
      '--use-api': 1,
      '--use-docker': 1,
      '--legacy-bundle': 1,
      '--project-ref': 1,
      '--remote': 1,
    });
  });

  it.each([
    ['--remote', 'supabase functions download --remote apply-promo'],
    ['--remote', `supabase functions download apply-promo --remote=${REF}`],
    ['--remote', 'supabase functions download apply-promo --remote'],
    ['--remote', 'supabase functions --remote=staging download apply-promo'],
    ['--project-ref', `supabase functions download --project-ref=${REF}`],
    [
      '--use-docker',
      'supabase functions download apply-promo --use-docker=true',
    ],
    ['--use-api', 'supabase functions download apply-promo --use-api=true'],
    ['--legacy-bundle', 'supabase functions download --legacy-bundle=true'],
  ])('counts %s in %s, bare or joined with =', (flag, command) => {
    expect(downloadFlagsOf([command])).toEqual({ [flag]: 1 });
  });

  it.each([
    'supabase functions download apply-promo --use-docker=false',
    'supabase functions download apply-promo --use-api=false',
    'supabase functions download apply-promo --legacy-bundle=false',
  ])('does not count a flag switched off with =false in %s', (command) => {
    expect(downloadFlagsOf([command])).toEqual({});
  });

  it('counts a flag once per invocation that carries it', () => {
    expect(
      downloadFlagsOf([
        'supabase functions download apply-promo --use-api',
        'supabase functions download apply-promo --use-api --legacy-bundle',
        'supabase functions download apply-promo',
      ])
    ).toEqual({ '--use-api': 2, '--legacy-bundle': 1 });
  });

  it('counts the flags of a download that follows global value flags', () => {
    expect(
      downloadFlagsOf([
        'supabase --workdir app functions download apply-promo --use-api',
        'supabase -o json functions download --legacy-bundle',
      ])
    ).toEqual({ '--use-api': 1, '--legacy-bundle': 1 });
  });

  it('counts the flags of a download chained after a link', () => {
    expect(
      downloadFlagsOf([
        `supabase link --project-ref ${REF} && supabase functions download apply-promo --use-api`,
      ])
    ).toEqual({ '--use-api': 1 });
  });

  it('ignores the same flags on other subcommands, deploy included', () => {
    expect(
      downloadFlagsOf([
        `supabase link --project-ref ${REF}`,
        `supabase projects api-keys --project-ref ${REF}`,
        'supabase functions serve --no-verify-jwt',
        `supabase functions list --project-ref ${REF}`,
        'supabase functions deploy apply-promo --use-api --remote',
      ])
    ).toEqual({});
  });

  it('ignores flags the journey does not track on a download', () => {
    expect(
      downloadFlagsOf([
        'supabase functions download apply-promo --debug --no-verify-jwt --prune',
      ])
    ).toEqual({});
  });

  it('returns nothing for a download without flags and for no invocations', () => {
    expect(
      downloadFlagsOf(['supabase functions download apply-promo'])
    ).toEqual({});
    expect(downloadFlags([])).toEqual({});
  });

  it('does not count a download that only asked for help', () => {
    expect(
      downloadFlagsOf(['supabase functions download --help --use-api'])
    ).toEqual({});
  });
});

describe('deployFlags', () => {
  it('counts each tracked flag on a functions deploy', () => {
    expect(
      deployFlagsOf([
        `supabase functions deploy apply-promo --use-api --project-ref ${REF}`,
      ])
    ).toEqual({ '--use-api': 1, '--project-ref': 1 });
  });

  it('counts every tracked flag', () => {
    expect(
      deployFlagsOf([
        `supabase functions deploy --use-api --use-docker --no-verify-jwt --project-ref ${REF} --remote --prune`,
      ])
    ).toEqual({
      '--use-api': 1,
      '--use-docker': 1,
      '--no-verify-jwt': 1,
      '--project-ref': 1,
      '--remote': 1,
      '--prune': 1,
    });
  });

  it.each([
    ['--remote', 'supabase functions deploy --remote apply-promo'],
    ['--remote', `supabase functions deploy --remote=${REF}`],
    ['--remote', 'supabase functions deploy apply-promo --remote'],
    ['--remote', 'supabase functions --remote=staging deploy'],
    ['--project-ref', `supabase functions deploy --project-ref=${REF}`],
    ['--use-docker', 'supabase functions deploy --use-docker=true'],
    ['--use-api', 'supabase functions deploy --use-api=true'],
  ])('counts %s in %s, bare or joined with =', (flag, command) => {
    expect(deployFlagsOf([command])).toEqual({ [flag]: 1 });
  });

  it.each([
    'supabase functions deploy apply-promo --use-docker=false',
    'supabase functions deploy apply-promo --use-api=false',
    'supabase functions deploy apply-promo --no-verify-jwt=false',
    'supabase functions deploy apply-promo --prune=false',
  ])('does not count a flag switched off with =false in %s', (command) => {
    expect(deployFlagsOf([command])).toEqual({});
  });

  it('counts a flag once per invocation that carries it', () => {
    expect(
      deployFlagsOf([
        'supabase functions deploy --use-api',
        'supabase functions deploy apply-promo --use-api --no-verify-jwt',
        'supabase functions deploy',
      ])
    ).toEqual({ '--use-api': 2, '--no-verify-jwt': 1 });
  });

  it('counts the flags of a deploy that follows global value flags', () => {
    expect(
      deployFlagsOf([
        'supabase --workdir app functions deploy --use-api',
        'supabase -o json functions deploy --no-verify-jwt',
      ])
    ).toEqual({ '--use-api': 1, '--no-verify-jwt': 1 });
  });

  it('counts the flags of a deploy chained after a download', () => {
    expect(
      deployFlagsOf([
        'supabase functions download apply-promo --use-api && supabase functions deploy apply-promo --no-verify-jwt',
      ])
    ).toEqual({ '--no-verify-jwt': 1 });
  });

  it('ignores the same flags on other subcommands, download included', () => {
    expect(
      deployFlagsOf([
        `supabase link --project-ref ${REF}`,
        `supabase projects api-keys --project-ref ${REF}`,
        'supabase functions serve --no-verify-jwt',
        `supabase functions list --project-ref ${REF}`,
        'supabase functions download apply-promo --use-api --remote --legacy-bundle',
      ])
    ).toEqual({});
  });

  it('ignores flags the journey does not track on a deploy', () => {
    expect(
      deployFlagsOf([
        'supabase functions deploy --debug --import-map ./map.json --legacy-bundle',
      ])
    ).toEqual({});
  });

  it('returns nothing for a deploy without flags and for no invocations', () => {
    expect(deployFlagsOf(['supabase functions deploy'])).toEqual({});
    expect(deployFlags([])).toEqual({});
  });

  it('does not count a deploy that only asked for help', () => {
    expect(
      deployFlagsOf(['supabase functions deploy --help --use-api'])
    ).toEqual({});
  });
});

describe('readLocalSource', () => {
  it('is true when the download left supabase/functions/apply-promo/index.ts in the workspace', () => {
    const root = workspace({
      'supabase/config.toml': 'project_id = "storefront"\n',
      'supabase/functions/apply-promo/index.ts':
        'Deno.serve(() => new Response());',
    });
    expect(readLocalSource(root)).toBe(true);
  });

  it('is false for a workspace with only the config', () => {
    expect(
      readLocalSource(
        workspace({ 'supabase/config.toml': 'project_id = "x"\n' })
      )
    ).toBe(false);
  });

  it('is false for an empty workspace, not null', () => {
    expect(readLocalSource(workspace({}))).toBe(false);
  });

  it('is false when the function folder holds no index.ts', () => {
    expect(
      readLocalSource(
        workspace({ 'supabase/functions/apply-promo/deno.json': '{}' })
      )
    ).toBe(false);
  });

  it('is false when only another function has an index.ts', () => {
    expect(
      readLocalSource(
        workspace({ 'supabase/functions/other-fn/index.ts': 'export {};' })
      )
    ).toBe(false);
  });

  it('is false when the source was saved outside supabase/functions', () => {
    expect(
      readLocalSource(workspace({ 'apply-promo/index.ts': 'export {};' }))
    ).toBe(false);
  });

  it('is false for a workspace directory that does not exist', () => {
    const root = workspace({});
    fs.rmSync(root, { recursive: true });
    expect(readLocalSource(root)).toBe(false);
  });

  it('is false when a path component is a regular file', () => {
    const root = workspace({ 'supabase/functions': 'not a directory' });
    expect(readLocalSource(root)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    'is null when the workspace cannot be read for a reason other than a missing path',
    () => {
      const root = workspace({
        'supabase/functions/apply-promo/index.ts': 'export {};',
      });
      const locked = path.join(root, 'supabase');
      fs.chmodSync(locked, 0o000);
      try {
        expect(readLocalSource(root)).toBeNull();
      } finally {
        fs.chmodSync(locked, 0o755);
      }
    }
  );
});

describe('readCliFacts', () => {
  it('reads the staged CLI version and no override for a plain run', async () => {
    const invocations = findSupabaseInvocations([
      'supabase functions download apply-promo',
    ]);
    expect(await readCliFacts(ctx, MARKER, invocations)).toEqual({
      versions: { cliVersion: '2.0.0' },
      cliOverride: [],
    });
  });

  it('reports a version-swapping runner and a PATH version that moved', async () => {
    const invocations = findSupabaseInvocations([
      'npx --yes supabase@2.1.0 functions download apply-promo',
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
    `supabase link --project-ref ${REF}`,
    'supabase functions download apply-promo --use-api',
    `supabase functions deploy apply-promo --use-api --project-ref ${REF}`,
    'supabase projects api-keys',
    `curl -s https://${REF}.supabase.co/functions/v1/apply-promo`,
    'sudo apt-get install docker.io',
  ];

  const baseFacts = {
    commands: [] as string[],
    invocations: [] as SupabaseInvocation[],
    hosted: true,
    deployment: DEPLOYED as DeploymentProbe,
    localSource: true as boolean | null,
  };

  const metricsFor = async (overrides: Partial<typeof baseFacts> = {}) =>
    checkMetrics(MARKER, {
      ...baseFacts,
      ...overrides,
      cli: await readCliFacts(ctx, MARKER, []),
    });

  it('reports every field and always passes', async () => {
    const invocations = findSupabaseInvocations(commands);
    const check = await checkMetrics(MARKER, {
      commands,
      invocations,
      hosted: true,
      deployment: DEPLOYED,
      cli: await readCliFacts(ctx, MARKER, invocations),
      localSource: true,
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
      'deployedVersion',
      'downloadFlags',
      'hostedProject',
      'localSourcePresent',
    ]);
    expect(metrics).toEqual({
      cliVersion: '2.0.0',
      cliOverride: [],
      channel: 'beta',
      hostedProject: true,
      deployedStatus: 'ACTIVE',
      deployedVersion: 2,
      deployedVerifyJwt: true,
      localSourcePresent: true,
      cliCommands: {
        login: 1,
        link: 1,
        'functions download': 1,
        'functions deploy': 1,
        'projects api-keys': 1,
      },
      downloadFlags: { '--use-api': 1 },
      deployFlags: { '--use-api': 1, '--project-ref': 1 },
      cliDetours: 1,
    });
  });

  it('reports a deployed function with JWT verification off as false, not null', async () => {
    const check = await metricsFor({
      deployment: {
        ok: true,
        deployed: { status: 'ACTIVE', verifyJwt: false, version: 2 },
      },
    });
    expect(metricsOf(check)).toMatchObject({
      deployedStatus: 'ACTIVE',
      deployedVerifyJwt: false,
    });
  });

  it('reports the status of a function that is not ACTIVE', async () => {
    const check = await metricsFor({
      deployment: {
        ok: true,
        deployed: { status: 'THROTTLED', verifyJwt: true, version: 2 },
      },
    });
    expect(metricsOf(check)).toMatchObject({ deployedStatus: 'THROTTLED' });
  });

  it('reports the seeded version 1 when nothing was redeployed', async () => {
    const check = await metricsFor({
      deployment: {
        ok: true,
        deployed: { status: 'ACTIVE', verifyJwt: true, version: 1 },
      },
    });
    expect(metricsOf(check)).toMatchObject({ deployedVersion: 1 });
  });

  it('reports null version and JWT setting when the API did not report them', async () => {
    const check = await metricsFor({
      deployment: {
        ok: true,
        deployed: {
          status: 'ACTIVE',
          verifyJwt: undefined,
          version: undefined,
        },
      },
    });
    expect(metricsOf(check)).toMatchObject({
      deployedStatus: 'ACTIVE',
      deployedVersion: null,
      deployedVerifyJwt: null,
    });
  });

  it.each([
    ['a function that was never deployed', NOT_DEPLOYED],
    ['a deployment that could not be read', UNAVAILABLE],
  ])(
    'reports null status, version and JWT setting for %s',
    async (_label, deployment) => {
      const check = await metricsFor({ deployment });
      expect(metricsOf(check)).toMatchObject({
        hostedProject: true,
        deployedStatus: null,
        deployedVersion: null,
        deployedVerifyJwt: null,
      });
    }
  );

  it.each([
    [true, true],
    [false, false],
    [null, null],
  ])(
    'reports a local source of %s as localSourcePresent %s',
    async (localSource, expected) => {
      const check = await metricsFor({ localSource });
      expect(metricsOf(check).localSourcePresent).toBe(expected);
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
      localSource: null,
    });
    expect(check.passed).toBe(true);
    expect(metricsOf(check)).toMatchObject({
      cliVersion: null,
      channel: 'pinned',
      hostedProject: false,
      deployedStatus: null,
      deployedVersion: null,
      deployedVerifyJwt: null,
      localSourcePresent: null,
      cliCommands: {},
      downloadFlags: {},
      deployFlags: {},
      cliDetours: 0,
    });
  });

  it('reports a PATH version that moved and the override runner', async () => {
    const runnerCommands = [
      'npx --yes supabase@2.1.0 functions download apply-promo',
    ];
    const invocations = findSupabaseInvocations(runnerCommands);
    const check = await checkMetrics(MARKER, {
      ...baseFacts,
      commands: runnerCommands,
      invocations,
      cli: await readCliFacts(movedCtx, MARKER, invocations),
    });
    expect(metricsOf(check)).toMatchObject({
      cliVersion: '2.0.0',
      cliVersionAfterRun: '2.2.0',
      cliOverride: ['npx --yes supabase@2.1.0'],
    });
  });

  it('omits cliVersionAfterRun when the PATH version did not move', async () => {
    expect(metricsOf(await metricsFor())).not.toHaveProperty(
      'cliVersionAfterRun'
    );
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
      localSource: true,
    });
    expect(check).toMatchObject({ name: 'metrics', passed: true });
    expect(metricsOf(check)).toMatchObject({
      cliVersion: '2.0.0',
      hostedProject: true,
      deployedStatus: null,
      deployedVersion: null,
      deployedVerifyJwt: null,
      localSourcePresent: true,
      cliCommands: { 'functions download': 1, 'functions deploy': 1 },
      downloadFlags: { '--use-api': 1 },
      deployFlags: { '--use-api': 1 },
      cliDetours: 1,
    });
  });

  it('keeps the other fields when the invocations cannot be counted', async () => {
    const check = await metricsFor({
      commands,
      invocations: [null] as unknown as SupabaseInvocation[],
    });
    expect(check.passed).toBe(true);
    expect(metricsOf(check)).toMatchObject({
      cliVersion: '2.0.0',
      deployedStatus: 'ACTIVE',
      deployedVersion: 2,
      localSourcePresent: true,
      cliCommands: null,
      downloadFlags: null,
      deployFlags: null,
      cliDetours: 1,
    });
  });

  it('keeps the other fields when the commands cannot be scanned', async () => {
    const check = await metricsFor({
      commands: [undefined] as unknown as string[],
    });
    expect(check.passed).toBe(true);
    expect(metricsOf(check)).toMatchObject({
      cliVersion: '2.0.0',
      hostedProject: true,
      deployedStatus: 'ACTIVE',
      deployedVersion: 2,
      cliDetours: null,
    });
  });
});
