// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-database-005-preview-branch-lifecycle
import type {
  CommandResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import {
  findSupabaseInvocations,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import type { BranchesProbe } from './branches.js';
import {
  BRANCH_REF,
  DEFAULT_SUMMARY,
  iso,
  OLDER_SUMMARY,
  productionProbe,
  REF,
  SESSION_START,
  summary,
} from './fakes.js';
import { NO_HOSTED_PROJECT } from './hosted.js';
import {
  type CliFacts,
  checkMetrics,
  countCliCommands,
  dbPushFlags,
  readCliFacts,
  readLinkedRef,
} from './metrics.js';
import type { ProductionProbe } from './production.js';

const MARKER: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'beta',
  cliVersion: '2.0.0',
  docker: 'available',
  sessionStartedMs: SESSION_START,
};

const SBP = `sbp_${'e'.repeat(40)}`;
const BRANCH_DB_URL = `postgresql://postgres.${BRANCH_REF}:not-a-real-password-123@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`;

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

const versionCtx: Pick<LocalStackEvalContext, 'exec'> = {
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

const nonZero = (counts: Record<string, number> | null | undefined) =>
  Object.fromEntries(
    Object.entries(counts ?? {}).filter(([, count]) => count !== 0)
  );

const countOf = (commands: string[]) =>
  nonZero(countCliCommands(findSupabaseInvocations(commands)));

const flagsOf = (commands: string[]) =>
  nonZero(dbPushFlags(findSupabaseInvocations(commands)));

const total = (counts: Record<string, number>) =>
  Object.values(counts).reduce((sum, n) => sum + n, 0);

describe('countCliCommands', () => {
  it('counts each preview-branch journey subcommand under its own key', () => {
    expect(
      countOf([
        'supabase branches create preview-shipments',
        'supabase branches list',
        'supabase branches get preview-shipments',
        'supabase branches delete preview-shipments',
        'supabase branches update preview-shipments --persistent',
        'supabase branches pause preview-shipments',
        'supabase branches unpause preview-shipments',
        'supabase branches disable',
        `supabase db push --db-url ${BRANCH_DB_URL}`,
        'supabase db reset --linked',
        'supabase db query "select 1" --linked',
        `supabase migration list --db-url ${BRANCH_DB_URL}`,
        `supabase migration up --db-url ${BRANCH_DB_URL}`,
        `supabase link --project-ref ${REF}`,
        `supabase login --token ${SBP}`,
        'supabase start',
        'supabase status',
        'supabase projects list',
      ])
    ).toEqual({
      'branches create': 1,
      'branches list': 1,
      'branches get': 1,
      'branches delete': 1,
      'branches update': 1,
      'branches pause': 1,
      'branches unpause': 1,
      'branches disable': 1,
      'db push': 1,
      'db reset': 1,
      'db query': 1,
      'migration list': 1,
      'migration up': 1,
      link: 1,
      login: 1,
      start: 1,
      status: 1,
      'projects list': 1,
    });
  });

  it('counts repeated subcommands', () => {
    expect(
      countOf([
        'supabase branches create a',
        'supabase branches create b',
        'supabase db push --linked',
      ])
    ).toEqual({ 'branches create': 2, 'db push': 1 });
  });

  it('files every other subcommand under other', () => {
    expect(
      countOf([
        'supabase db diff',
        'supabase db pull',
        'supabase db dump',
        'supabase migration new add_x',
        'supabase migration repair 20261020120000 --status applied',
        'supabase projects create demo',
        'supabase projects api-keys',
        'supabase stop',
        'supabase branches',
        'supabase db',
        'supabase migration',
        'supabase projects',
        'supabase',
      ])
    ).toEqual({ other: 13 });
  });

  it.each([
    ['supabase --workdir app branches create x', 'branches create'],
    ['supabase --workdir=app branches create x', 'branches create'],
    ['supabase --profile staging branches list', 'branches list'],
    ['supabase -o json branches list', 'branches list'],
    ['supabase --output json branches get x', 'branches get'],
    ['supabase --experimental branches create x', 'branches create'],
    ['supabase --debug db push --linked', 'db push'],
    ['supabase db push --linked --dry-run', 'db push'],
    [
      'supabase branches create x --project-ref abcdefghijklmnopqrst',
      'branches create',
    ],
    ['supabase branches delete x --yes', 'branches delete'],
    ['supabase migration list --linked', 'migration list'],
    ['supabase link --project-ref abcdefghijklmnopqrst', 'link'],
    ['supabase status -o env', 'status'],
    ['supabase --workdir app', 'other'],
  ])('keys %s as %s', (command, key) => {
    expect(countOf([command])).toEqual({ [key]: 1 });
  });

  it('counts a command run through npx, a shell wrapper or a chain', () => {
    expect(
      countOf([
        'npx supabase branches create x',
        "bash -lc 'supabase branches list'",
        `supabase link --project-ref ${REF} && supabase db push --linked`,
      ])
    ).toEqual({
      'branches create': 1,
      'branches list': 1,
      link: 1,
      'db push': 1,
    });
  });

  it('does not count --help invocations or commands that are not the supabase CLI', () => {
    expect(
      total(
        countOf([
          'supabase branches create --help',
          'supabase db push -h',
          'echo supabase branches create x',
          'curl -s https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/branches',
          'psql "$BRANCH_URL" -c "select 1"',
          'ls supabase/migrations',
        ])
      )
    ).toBe(0);
  });

  it('returns no counts when there are no invocations', () => {
    expect(nonZero(countCliCommands([]))).toEqual({});
  });
});

describe('dbPushFlags', () => {
  it('counts each tracked flag on a db push', () => {
    expect(
      flagsOf([`supabase db push --db-url ${BRANCH_DB_URL} --include-all`])
    ).toEqual({ '--db-url': 1, '--include-all': 1 });
  });

  it('counts every tracked flag', () => {
    expect(
      flagsOf([
        `supabase db push --db-url ${BRANCH_DB_URL} --linked --local --project-ref ${REF} --dry-run --include-all`,
      ])
    ).toEqual({
      '--db-url': 1,
      '--linked': 1,
      '--local': 1,
      '--project-ref': 1,
      '--dry-run': 1,
      '--include-all': 1,
    });
  });

  it('counts the flag=value form of a flag', () => {
    expect(
      flagsOf([
        `supabase db push --db-url=${BRANCH_DB_URL}`,
        `supabase db push --project-ref=${REF}`,
      ])
    ).toEqual({ '--db-url': 1, '--project-ref': 1 });
  });

  it('counts a flag once per invocation that carries it', () => {
    expect(
      flagsOf([
        'supabase db push --linked',
        'supabase db push --linked --dry-run',
        'supabase db push --dry-run',
        'supabase db push',
      ])
    ).toEqual({ '--linked': 2, '--dry-run': 2 });
  });

  it('counts the flags of a push that follows global value flags', () => {
    expect(
      flagsOf([
        'supabase --workdir app db push --linked',
        'supabase -o json db push --dry-run',
      ])
    ).toEqual({ '--linked': 1, '--dry-run': 1 });
  });

  it('counts the flags of a push chained after a link', () => {
    expect(
      flagsOf([
        `supabase link --project-ref ${REF} && supabase db push --include-all`,
      ])
    ).toEqual({ '--include-all': 1 });
  });

  it('ignores the same flags on other subcommands', () => {
    expect(
      flagsOf([
        `supabase link --project-ref ${REF}`,
        `supabase migration up --db-url ${BRANCH_DB_URL}`,
        'supabase migration list --linked',
        'supabase db reset --linked',
        `supabase branches create x --project-ref ${REF}`,
        'supabase db diff --local',
      ])
    ).toEqual({});
  });

  it('ignores flags that are not tracked', () => {
    expect(flagsOf(['supabase db push --debug --yes'])).toEqual({});
  });

  it('does not count a push that only asked for help', () => {
    expect(flagsOf(['supabase db push --help --linked'])).toEqual({});
  });

  it('returns nothing for a push without flags and for no invocations', () => {
    expect(flagsOf(['supabase db push'])).toEqual({});
    expect(nonZero(dbPushFlags([]))).toEqual({});
  });
});

describe('readCliFacts', () => {
  it('reads the staged CLI version and no override for a plain run', async () => {
    const invocations = findSupabaseInvocations(['supabase branches create x']);
    expect(await readCliFacts(versionCtx, MARKER, invocations)).toEqual({
      versions: { cliVersion: '2.0.0' },
      cliOverride: [],
    });
  });

  it('reports a version-swapping runner and a PATH version that moved', async () => {
    const invocations = findSupabaseInvocations([
      'npx --yes supabase@2.1.0 branches create x',
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

describe('readLinkedRef', () => {
  const ctxWith = (exec: (command: string) => Promise<CommandResult>) => ({
    hostedRef: REF,
    exec: vi.fn(exec),
  });

  it('reads the linked ref from the workspace with cat', async () => {
    const ctx = ctxWith(async () => commandResult(`${REF}\n`));
    await readLinkedRef(ctx);
    expect(ctx.exec).toHaveBeenCalledWith('cat supabase/.temp/project-ref');
  });

  it.each([
    ['with a trailing newline', `${REF}\n`],
    ['with no newline', REF],
    ['with surrounding whitespace', `  ${REF}  \n`],
  ])(
    'says production when the linked ref is the hosted ref %s',
    async (_label, stdout) => {
      expect(
        await readLinkedRef(ctxWith(async () => commandResult(stdout)))
      ).toBe('production');
    }
  );

  it('says other when the workspace is linked to a different project, such as a branch', async () => {
    expect(
      await readLinkedRef(ctxWith(async () => commandResult(`${BRANCH_REF}\n`)))
    ).toBe('other');
  });

  it('says other for a ref that only starts with the hosted ref', async () => {
    expect(
      await readLinkedRef(ctxWith(async () => commandResult(`${REF}x\n`)))
    ).toBe('other');
  });

  it('says none when the file cannot be read', async () => {
    expect(
      await readLinkedRef(
        ctxWith(async () =>
          commandResult('cat: supabase/.temp/project-ref: No such file', false)
        )
      )
    ).toBe('none');
  });

  it.each([
    ['empty', ''],
    ['blank', ' \n'],
  ])('says none when the file is %s', async (_label, stdout) => {
    expect(
      await readLinkedRef(ctxWith(async () => commandResult(stdout)))
    ).toBe('none');
  });

  it('is null, not none, when the command throws', async () => {
    expect(
      await readLinkedRef(
        ctxWith(async () => {
          throw new Error('sandbox gone');
        })
      )
    ).toBeNull();
  });
});

describe('checkMetrics', () => {
  const commands = [
    `supabase login --token ${SBP}`,
    `supabase link --project-ref ${REF}`,
    'supabase branches create preview-shipments',
    `supabase db push --db-url ${BRANCH_DB_URL} --include-all`,
    `supabase migration list --db-url ${BRANCH_DB_URL}`,
    'supabase branches delete preview-shipments',
    'sudo apt-get install docker.io',
  ];

  const scheduledAt = iso(SESSION_START + 120_000);

  const branches: BranchesProbe = {
    ok: true,
    branches: [
      DEFAULT_SUMMARY,
      OLDER_SUMMARY,
      summary({ name: 'preview-leftover', status: 'RUNNING_MIGRATIONS' }),
      summary({ name: 'preview-shipments', deletionScheduledAt: scheduledAt }),
    ],
  };

  const BASELINE = {
    cliVersion: '2.0.0',
    cliOverride: [],
    channel: 'beta',
    hostedProject: true,
    productionNewMigration: false,
    productionNewTable: false,
    productionOrders: 12,
    runBranchesLeft: ['preview-leftover'],
    runBranchesScheduled: ['preview-shipments'],
    cliCommands: {
      login: 1,
      link: 1,
      'branches create': 1,
      'db push': 1,
      'migration list': 1,
      'branches delete': 1,
    },
    dbPushFlags: { '--db-url': 1, '--include-all': 1 },
    linkedRefAtEnd: 'production',
    cliDetours: 1,
  };

  type Facts = Parameters<typeof checkMetrics>[1];

  const healthyFacts = async (): Promise<Facts> => {
    const invocations = findSupabaseInvocations(commands);
    return {
      commands,
      invocations,
      hosted: true,
      production: productionProbe(),
      branches,
      sessionStartMs: SESSION_START,
      cli: await readCliFacts(versionCtx, MARKER, invocations),
      linkedRef: 'production',
      refs: [],
    };
  };

  const metricsWith = async (
    facts: Facts,
    marker: LocalStackEnvironmentMarker | undefined
  ) => {
    const check = await checkMetrics(marker, facts);
    expect(check).toMatchObject({ name: 'metrics', passed: true });
    const parsed = JSON.parse(check.notes ?? '{}');
    return {
      ...parsed,
      cliCommands:
        parsed.cliCommands === null ? null : nonZero(parsed.cliCommands),
      dbPushFlags:
        parsed.dbPushFlags === null ? null : nonZero(parsed.dbPushFlags),
    };
  };

  const metricsOf = (facts: Facts) => metricsWith(facts, MARKER);

  it('reports every field and always passes', async () => {
    const metrics = await metricsOf(await healthyFacts());
    expect(Object.keys(metrics).sort()).toEqual([
      'channel',
      'cliCommands',
      'cliDetours',
      'cliOverride',
      'cliVersion',
      'dbPushFlags',
      'hostedProject',
      'linkedRefAtEnd',
      'productionNewMigration',
      'productionNewTable',
      'productionOrders',
      'runBranchesLeft',
      'runBranchesScheduled',
    ]);
    expect(metrics).toEqual(BASELINE);
  });

  it('reports a pushed production, with the real row count', async () => {
    expect(
      await metricsOf({
        ...(await healthyFacts()),
        production: productionProbe({
          newVersionRecorded: true,
          newTablePresent: true,
          orderRows: 3,
        }),
      })
    ).toEqual({
      ...BASELINE,
      productionNewMigration: true,
      productionNewTable: true,
      productionOrders: 3,
    });
  });

  it('reports a missing orders table as null rows, not zero', async () => {
    expect(
      await metricsOf({
        ...(await healthyFacts()),
        production: productionProbe({ ordersPresent: false, orderRows: null }),
      })
    ).toMatchObject({ productionOrders: null });
  });

  it('reports an empty orders table as zero rows, not null', async () => {
    expect(
      await metricsOf({
        ...(await healthyFacts()),
        production: productionProbe({ orderRows: 0 }),
      })
    ).toMatchObject({ productionOrders: 0 });
  });

  it('reports a clean run as no branches left and none scheduled', async () => {
    expect(
      await metricsOf({
        ...(await healthyFacts()),
        branches: { ok: true, branches: [DEFAULT_SUMMARY, OLDER_SUMMARY] },
      })
    ).toMatchObject({ runBranchesLeft: [], runBranchesScheduled: [] });
  });

  it('counts a branch older than the session start as left or scheduled when a create printed its ref', async () => {
    const skewed = summary({
      name: 'skewed-running',
      projectRef: 'mnopqrstuvwxyzabcdef',
      status: 'RUNNING_MIGRATIONS',
      createdAtMs: SESSION_START - 1_000,
    });
    const skewedRemoved = summary({
      name: 'skewed-removed',
      projectRef: 'uvwxyzabcdefghijklmn',
      createdAtMs: SESSION_START - 1_000,
      previewProjectStatus: 'REMOVED',
    });
    const facts = await healthyFacts();
    const withBoth: Facts = {
      ...facts,
      branches: { ok: true, branches: [skewed, skewedRemoved] },
    };
    expect(await metricsOf(withBoth)).toMatchObject({
      runBranchesLeft: [],
      runBranchesScheduled: [],
    });
    expect(
      await metricsOf({
        ...withBoth,
        refs: ['mnopqrstuvwxyzabcdef', 'uvwxyzabcdefghijklmn'],
      })
    ).toMatchObject({
      runBranchesLeft: ['skewed-running'],
      runBranchesScheduled: ['skewed-removed'],
    });
  });

  it('reports the linked ref as given', async () => {
    for (const linkedRef of ['production', 'other', 'none', null] as const) {
      expect(
        await metricsOf({ ...(await healthyFacts()), linkedRef })
      ).toMatchObject({ linkedRefAtEnd: linkedRef });
    }
  });

  it('reports nulls for what an unreadable production and branch listing cannot say', async () => {
    expect(
      await metricsOf({
        ...(await healthyFacts()),
        production: { ok: false, notes: NO_HOSTED_PROJECT },
        branches: { ok: false, notes: NO_HOSTED_PROJECT },
      })
    ).toEqual({
      ...BASELINE,
      productionNewMigration: null,
      productionNewTable: null,
      productionOrders: null,
      runBranchesLeft: null,
      runBranchesScheduled: null,
    });
  });

  it('reports no branch lists when the session start is unknown', async () => {
    expect(
      await metricsOf({ ...(await healthyFacts()), sessionStartMs: null })
    ).toMatchObject({ runBranchesLeft: null, runBranchesScheduled: null });
  });

  it('defaults the channel to pinned when the marker has none or there is no marker', async () => {
    const { channel: _channel, ...unnamed } = MARKER;
    expect(await metricsWith(await healthyFacts(), unnamed)).toMatchObject({
      channel: 'pinned',
    });
    expect(await metricsWith(await healthyFacts(), undefined)).toMatchObject({
      channel: 'pinned',
    });
  });

  it.each(['stable', 'beta', 'next'] as const)(
    'reports the %s channel',
    async (channel) => {
      expect(
        await metricsWith(await healthyFacts(), { ...MARKER, channel })
      ).toMatchObject({ channel });
    }
  );

  it('reports a PATH version that moved and the override runner', async () => {
    const runnerCommands = ['npx --yes supabase@2.1.0 branches create x'];
    const invocations = findSupabaseInvocations(runnerCommands);
    expect(
      await metricsOf({
        ...(await healthyFacts()),
        commands: runnerCommands,
        invocations,
        cli: await readCliFacts(movedCtx, MARKER, invocations),
      })
    ).toMatchObject({
      cliVersion: '2.0.0',
      cliVersionAfterRun: '2.2.0',
      cliOverride: ['npx --yes supabase@2.1.0'],
    });
  });

  it('omits cliVersionAfterRun when the PATH version did not move', async () => {
    expect(await metricsOf(await healthyFacts())).not.toHaveProperty(
      'cliVersionAfterRun'
    );
  });

  it('reports nulls and zero detours instead of failing when nothing could be read', async () => {
    const failing: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async () => {
        throw new Error('sandbox gone');
      },
    };
    const check = await checkMetrics(undefined, {
      commands: [],
      invocations: [],
      hosted: false,
      production: { ok: false, notes: NO_HOSTED_PROJECT },
      branches: { ok: false, notes: NO_HOSTED_PROJECT },
      sessionStartMs: null,
      cli: await readCliFacts(failing, undefined, []),
      linkedRef: null,
      refs: [],
    });
    expect(check.passed).toBe(true);
    expect(JSON.parse(check.notes ?? '{}')).toMatchObject({
      cliVersion: null,
      channel: 'pinned',
      hostedProject: false,
      productionNewMigration: null,
      productionNewTable: null,
      productionOrders: null,
      runBranchesLeft: null,
      runBranchesScheduled: null,
      cliCommands: {},
      dbPushFlags: {},
      linkedRefAtEnd: null,
      cliDetours: 0,
    });
  });

  describe('when one input cannot be read', () => {
    const throwing = <T>(shape: Record<string, unknown>, key: string) =>
      Object.defineProperty(shape, key, {
        enumerable: true,
        get(): never {
          throw new Error(`${key} unreadable`);
        },
      }) as unknown as T;

    it.each([
      [
        'the invocations',
        async (facts: Facts): Promise<Facts> => ({
          ...facts,
          invocations: [null] as unknown as SupabaseInvocation[],
        }),
        { cliCommands: null, dbPushFlags: null },
      ],
      [
        'the commands',
        async (facts: Facts): Promise<Facts> => ({
          ...facts,
          commands: [undefined] as unknown as string[],
        }),
        { cliDetours: null },
      ],
      [
        'the production state',
        async (facts: Facts): Promise<Facts> => ({
          ...facts,
          production: throwing<ProductionProbe>({ ok: true }, 'state'),
        }),
        {
          productionNewMigration: null,
          productionNewTable: null,
          productionOrders: null,
        },
      ],
      [
        'the branch listing',
        async (facts: Facts): Promise<Facts> => ({
          ...facts,
          branches: throwing<BranchesProbe>({ ok: true }, 'branches'),
        }),
        { runBranchesLeft: null, runBranchesScheduled: null },
      ],
      [
        'the CLI overrides',
        async (facts: Facts): Promise<Facts> => ({
          ...facts,
          cli: throwing<CliFacts>(
            { versions: { cliVersion: '2.0.0' } },
            'cliOverride'
          ),
        }),
        { cliOverride: null },
      ],
    ])(
      'keeps every other field when %s cannot be read',
      async (_label, break_, nulled) => {
        const facts = await break_(await healthyFacts());
        expect(await metricsOf(facts)).toEqual({ ...BASELINE, ...nulled });
      }
    );

    it('keeps every other field when the CLI versions cannot be read', async () => {
      const facts: Facts = {
        ...(await healthyFacts()),
        cli: throwing<CliFacts>({ cliOverride: [] }, 'versions'),
      };
      const metrics = await metricsOf(facts);
      const { cliVersion, cliVersionAfterRun: _moved, ...rest } = metrics;
      const { cliVersion: _baselineVersion, ...expectedRest } = BASELINE;
      expect(cliVersion).toBeNull();
      expect(rest).toEqual(expectedRest);
    });
  });
});
