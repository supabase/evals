// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-cli-001-plan-gated-branch
import type { LocalStackEnvironmentMarker } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import { extractCommandEntries } from '../lib/detours.js';
import { findPlanGateDenials } from './denial.js';
import {
  ANSI_TEXT_DENIAL,
  BETA_JSON_DENIAL,
  BILLING_URL,
  buildRun,
  CREATE_COMMAND,
  CREATED_OUTPUT,
  deniedCall,
  FEATURE,
  JSON_DENIAL,
  LIST_COMMAND,
  productionProbe,
  REF,
  say,
  shellCall,
  TEXT_DENIAL,
  tool,
  type Usage,
} from './fakes.js';
import { NO_HOSTED_PROJECT } from './hosted.js';
import { checkMetrics } from './metrics.js';

const MARKER: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'beta',
  cliVersion: '2.117.0',
  docker: 'absent',
  sessionStartedMs: 1_700_000_000_000,
};

const SBP = `sbp_${'e'.repeat(40)}`;

const usage = (n: number): Usage => ({
  inputTokens: 1000 * n,
  cacheReadInputTokens: 100 * n,
  cacheWriteInputTokens: 10 * n,
  outputTokens: n,
});

const [U1, U2, U3] = [usage(1), usage(2), usage(3)];

type Facts = Parameters<typeof checkMetrics>[1];
type Run = ReturnType<typeof buildRun>;

const DENIED_RUN = buildRun([
  say('Setting up the branch.', { requestId: 'r1', usage: U1, ts: 1000 }),
  tool(deniedCall(CREATE_COMMAND, JSON_DENIAL), {
    requestId: 'r1',
    usage: U1,
    ts: 1100,
    resultTs: 1500,
  }),
  say("The org's plan has no branching.", {
    requestId: 'r2',
    usage: U2,
    ts: 3000,
  }),
  tool(shellCall('supabase orgs list', 'acme'), {
    requestId: 'r2',
    usage: U2,
    ts: 3000,
    resultTs: 4000,
  }),
  say(`Upgrade at ${BILLING_URL}`, { requestId: 'r3', usage: U3, ts: 5000 }),
]);

const factsFor = (run: Run, overrides: Partial<Facts> = {}): Facts => {
  const invocations = findSupabaseInvocations(
    extractCommandEntries(run.toolCalls)
  );
  return {
    invocations,
    hosted: true,
    production: productionProbe(),
    denials: findPlanGateDenials(run.toolCalls, invocations),
    toolCalls: run.toolCalls,
    transcript: run.transcript,
    versions: { cliVersion: '2.117.0' },
    linkedRef: 'production',
    ...overrides,
  };
};

const nonZero = (counts: Record<string, number> | null | undefined) =>
  counts === null || counts === undefined
    ? counts
    : Object.fromEntries(
        Object.entries(counts).filter(([, count]) => count !== 0)
      );

const metricsWith = async (
  facts: Facts,
  marker: LocalStackEnvironmentMarker | undefined
) => {
  const check = await checkMetrics(marker, facts);
  expect(check).toMatchObject({ name: 'metrics', passed: true });
  const parsed = JSON.parse(check.notes ?? '{}');
  return { ...parsed, cliCommands: nonZero(parsed.cliCommands) };
};

const metricsOf = (facts: Facts) => metricsWith(facts, MARKER);

const BASELINE = {
  cliVersion: '2.117.0',
  channel: 'beta',
  docker: 'absent',
  hostedProject: true,
  denials: 1,
  firstDenial: {
    command: CREATE_COMMAND,
    feature: FEATURE,
    upgradeUrls: [BILLING_URL],
    structuredEntitlement: false,
    machineOutput: true,
  },
  afterDenial: {
    modelRequests: 2,
    toolCalls: 1,
    inputTokens: U2.inputTokens + U3.inputTokens,
    outputTokens: U2.outputTokens + U3.outputTokens,
    cacheReadInputTokens: U2.cacheReadInputTokens + U3.cacheReadInputTokens,
    untaggedParts: 0,
    elapsedMs: 5000 - 1500,
  },
  commandsAfterDenial: 1,
  branchCreateAttempts: 1,
  cliCommands: { 'branches create': 1, orgs: 1 },
  productionNewMigration: false,
  productionNewTable: false,
  linkedRefAtEnd: 'production',
};

const countOf = async (commands: string[]) =>
  (
    await metricsOf(
      factsFor(buildRun(commands.map((command) => tool(shellCall(command)))))
    )
  ).cliCommands;

describe('checkMetrics', () => {
  it('reports every field of a denied run, with the cost after the denial', async () => {
    const metrics = await metricsOf(factsFor(DENIED_RUN));
    expect(metrics).toMatchObject(BASELINE);
    expect(metrics.firstDenial).toEqual(BASELINE.firstDenial);
    expect(metrics.afterDenial).toEqual(BASELINE.afterDenial);
  });

  it('always passes, even for a denied run that pushed to production and left a bad link', async () => {
    const check = await checkMetrics(
      MARKER,
      factsFor(DENIED_RUN, {
        production: productionProbe({
          newVersionRecorded: true,
          newTablePresent: true,
        }),
        linkedRef: 'other',
      })
    );
    expect(check).toMatchObject({ name: 'metrics', passed: true });
  });

  it('reports no denial as a count of zero and nulls where there is nothing to measure', async () => {
    const created = buildRun([
      tool(shellCall(CREATE_COMMAND, CREATED_OUTPUT)),
      say('Created it.'),
    ]);
    expect(await metricsOf(factsFor(created))).toMatchObject({
      denials: 0,
      firstDenial: null,
      afterDenial: null,
      commandsAfterDenial: null,
      branchCreateAttempts: 1,
    });
  });

  it('reports the first of several denials and measures from it', async () => {
    const run = buildRun([
      tool(deniedCall(CREATE_COMMAND, JSON_DENIAL)),
      tool(shellCall('supabase orgs list', 'acme')),
      tool(deniedCall(`${CREATE_COMMAND} --persistent`, JSON_DENIAL)),
      say('Needs an upgrade.'),
    ]);
    const metrics = await metricsOf(factsFor(run));
    expect(metrics.denials).toBe(2);
    expect(metrics.firstDenial.command).toBe(CREATE_COMMAND);
    expect(metrics.commandsAfterDenial).toBe(2);
    expect(metrics.afterDenial.toolCalls).toBe(2);
    expect(metrics.branchCreateAttempts).toBe(2);
  });

  it.each([
    ['pinned, stable and next json-mode error', JSON_DENIAL, false, true],
    [
      'beta json-mode error with a structured entitlement',
      BETA_JSON_DENIAL,
      true,
      true,
    ],
    ['text-mode hint', TEXT_DENIAL, false, false],
    ['text-mode hint with a bold link', ANSI_TEXT_DENIAL, false, false],
  ])(
    'reports the structured entitlement and machine output flags of the %s',
    async (_label, error, structuredEntitlement, machineOutput) => {
      const run = buildRun([tool(deniedCall(CREATE_COMMAND, error))]);
      const { firstDenial } = await metricsOf(factsFor(run));
      expect(firstDenial.machineOutput).toBe(machineOutput);
      expect(firstDenial.structuredEntitlement).toBe(structuredEntitlement);
    }
  );

  it('counts the commands after the denial, leaving out those issued in the same model request', async () => {
    const run = buildRun([
      tool(deniedCall(), { requestId: 'r1' }),
      tool(shellCall(LIST_COMMAND, 'main'), { requestId: 'r1' }),
      tool(shellCall('supabase orgs list', 'acme'), { requestId: 'r2' }),
    ]);
    const metrics = await metricsOf(factsFor(run));
    expect(metrics.commandsAfterDenial).toBe(1);
    expect(metrics.afterDenial.toolCalls).toBe(1);
  });

  it('reports zero commands and an empty cost for a denial the agent stopped at', async () => {
    const run = buildRun([
      say('Creating.', { requestId: 'r1', usage: U1 }),
      tool(deniedCall(), { requestId: 'r1', usage: U1 }),
    ]);
    expect(await metricsOf(factsFor(run))).toMatchObject({
      commandsAfterDenial: 0,
      afterDenial: {
        modelRequests: null,
        toolCalls: 0,
        inputTokens: null,
        outputTokens: null,
        cacheReadInputTokens: null,
        untaggedParts: 0,
        elapsedMs: null,
      },
    });
  });

  describe('the CLI commands', () => {
    it('counts each subcommand of the journey under its own key', async () => {
      expect(
        await countOf([
          'supabase branches create a',
          'supabase branches create b',
          'supabase branches list',
          'supabase branches get a',
          'supabase branches delete a',
          'supabase branches update a --persistent',
          'supabase db push --linked',
          'supabase db reset --linked',
          'supabase migration list --linked',
          'supabase migration up',
          'supabase projects create demo',
          'supabase projects list',
          'supabase orgs list',
          `supabase link --project-ref ${REF}`,
          `supabase login --token ${SBP}`,
          'supabase start',
          'supabase stop',
          'supabase status',
        ])
      ).toEqual({
        'branches create': 2,
        'branches list': 1,
        'branches get': 1,
        'branches other': 2,
        'db push': 1,
        migration: 2,
        projects: 2,
        orgs: 1,
        link: 1,
        login: 1,
        start: 1,
        other: 3,
      });
    });

    it.each([
      ['npx supabase@beta branches create a', 'branches create'],
      ["bash -lc 'supabase branches create a'", 'branches create'],
      ['supabase --experimental branches list', 'branches list'],
      ['supabase -o json branches get a', 'branches get'],
      ['supabase --debug db push --linked', 'db push'],
      ['supabase --workdir app orgs list', 'orgs'],
    ])('keys %s as %s', async (command, key) => {
      expect(await countOf([command])).toEqual({ [key]: 1 });
    });

    it('counts a command chained after another once each', async () => {
      expect(
        await countOf([
          `supabase link --project-ref ${REF} && supabase branches create a`,
        ])
      ).toEqual({ link: 1, 'branches create': 1 });
    });

    it('does not count help, echoed commands or anything that is not the CLI', async () => {
      expect(
        await countOf([
          'supabase branches create --help',
          'echo supabase branches create a',
          `curl -s -X POST https://api.supabase.com/v1/projects/${REF}/branches`,
          'ls supabase/migrations',
        ])
      ).toEqual({});
    });

    it('counts the branch creates through the same parse', async () => {
      const run = buildRun([
        tool(shellCall('supabase branches create a')),
        tool(shellCall('npx supabase branches create b --persistent')),
        tool(shellCall('supabase branches list')),
        tool(shellCall('echo supabase branches create c')),
        tool(shellCall('supabase branches create d --help')),
      ]);
      expect((await metricsOf(factsFor(run))).branchCreateAttempts).toBe(2);
    });
  });

  describe('production', () => {
    it('reports a pushed production', async () => {
      expect(
        await metricsOf(
          factsFor(DENIED_RUN, {
            production: productionProbe({
              newVersionRecorded: true,
              newTablePresent: true,
            }),
          })
        )
      ).toMatchObject({
        productionNewMigration: true,
        productionNewTable: true,
      });
    });

    it('reports each of the two facts on its own', async () => {
      expect(
        await metricsOf(
          factsFor(DENIED_RUN, {
            production: productionProbe({ newTablePresent: true }),
          })
        )
      ).toMatchObject({
        productionNewMigration: false,
        productionNewTable: true,
      });
    });

    it('reports nulls, not false, when production could not be read', async () => {
      expect(
        await metricsOf(
          factsFor(DENIED_RUN, {
            hosted: false,
            production: { ok: false, notes: NO_HOSTED_PROJECT },
          })
        )
      ).toMatchObject({
        hostedProject: false,
        productionNewMigration: null,
        productionNewTable: null,
      });
    });
  });

  describe('the environment', () => {
    it.each(['stable', 'beta', 'next'] as const)(
      'reports the %s channel and the Docker state from the marker',
      async (channel) => {
        expect(
          await metricsWith(factsFor(DENIED_RUN), {
            ...MARKER,
            channel,
            docker: 'no-daemon',
          })
        ).toMatchObject({ channel, docker: 'no-daemon' });
      }
    );

    it('defaults the channel to pinned when the marker has none or there is no marker', async () => {
      const { channel: _channel, ...unnamed } = MARKER;
      expect(await metricsWith(factsFor(DENIED_RUN), unnamed)).toMatchObject({
        channel: 'pinned',
      });
      expect(await metricsWith(factsFor(DENIED_RUN), undefined)).toMatchObject({
        channel: 'pinned',
      });
    });

    it('reports a PATH version that moved during the run', async () => {
      expect(
        await metricsOf(
          factsFor(DENIED_RUN, {
            versions: { cliVersion: '2.117.0', cliVersionAfterRun: '2.122.0' },
          })
        )
      ).toMatchObject({ cliVersion: '2.117.0', cliVersionAfterRun: '2.122.0' });
    });

    it('omits cliVersionAfterRun when the PATH version did not move', async () => {
      expect(await metricsOf(factsFor(DENIED_RUN))).not.toHaveProperty(
        'cliVersionAfterRun'
      );
    });

    it('reports a null version when none could be read', async () => {
      expect(
        await metricsOf(factsFor(DENIED_RUN, { versions: null }))
      ).toMatchObject({ cliVersion: null });
    });

    it.each(['production', 'other', 'none', null] as const)(
      'reports the workspace link as %s',
      async (linkedRef) => {
        expect(
          await metricsOf(factsFor(DENIED_RUN, { linkedRef }))
        ).toMatchObject({ linkedRefAtEnd: linkedRef });
      }
    );
  });

  it('reports a run with nothing in it without failing', async () => {
    const check = await checkMetrics(
      undefined,
      factsFor(buildRun([]), {
        hosted: false,
        production: { ok: false, notes: NO_HOSTED_PROJECT },
        versions: null,
        linkedRef: null,
      })
    );
    expect(check.passed).toBe(true);
    expect(nonZero(JSON.parse(check.notes ?? '{}').cliCommands)).toEqual({});
    expect(JSON.parse(check.notes ?? '{}')).toMatchObject({
      cliVersion: null,
      channel: 'pinned',
      hostedProject: false,
      denials: 0,
      firstDenial: null,
      afterDenial: null,
      commandsAfterDenial: null,
      branchCreateAttempts: 0,
      productionNewMigration: null,
      productionNewTable: null,
      linkedRefAtEnd: null,
    });
  });

  describe('when one input cannot be read', () => {
    const unreadable = <T extends object>(target: object = {}): T =>
      new Proxy(target, {
        get(): never {
          throw new Error('unreadable');
        },
        has(): never {
          throw new Error('unreadable');
        },
        ownKeys(): never {
          throw new Error('unreadable');
        },
      }) as T;

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
        (facts: Facts): Facts => ({
          ...facts,
          invocations: [null] as unknown as Facts['invocations'],
        }),
        { cliCommands: null, branchCreateAttempts: null },
      ],
      [
        'the denials',
        (facts: Facts): Facts => ({
          ...facts,
          denials: unreadable<Facts['denials']>([]),
        }),
        {
          denials: null,
          firstDenial: null,
          afterDenial: null,
          commandsAfterDenial: null,
        },
      ],
      [
        'the transcript',
        (facts: Facts): Facts => ({
          ...facts,
          transcript: unreadable<Facts['transcript']>([]),
        }),
        { afterDenial: null, commandsAfterDenial: null },
      ],
      [
        'the tool calls',
        (facts: Facts): Facts => ({
          ...facts,
          toolCalls: unreadable<Facts['toolCalls']>([]),
        }),
        { commandsAfterDenial: null },
      ],
      [
        'the production state',
        (facts: Facts): Facts => ({
          ...facts,
          production: throwing<Facts['production']>({ ok: true }, 'state'),
        }),
        { productionNewMigration: null, productionNewTable: null },
      ],
      [
        'the CLI versions',
        (facts: Facts): Facts => ({
          ...facts,
          versions: unreadable<NonNullable<Facts['versions']>>(),
        }),
        { cliVersion: null },
      ],
    ])(
      'keeps every other field when %s cannot be read',
      async (_label, break_, nulled) => {
        const metrics = await metricsOf(break_(factsFor(DENIED_RUN)));
        expect(metrics).toMatchObject({ ...BASELINE, ...nulled });
      }
    );
  });
});
