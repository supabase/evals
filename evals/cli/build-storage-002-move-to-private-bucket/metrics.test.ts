import type {
  CommandResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import {
  readStackLifecycle,
  type StackLifecycle,
} from '../lib/stack-lifecycle.js';
import {
  basename,
  bucketSeeding,
  fetched,
  KEYS,
  mediaAvatars,
  mediaInvoiceHeld,
  movedInvoices,
  passingSeed,
  seedProbe,
  STACK,
  storageProbe,
  untouchedSeed,
} from './fakes.js';
import { AVATARS, INVOICES, MEDIA_BUCKET } from './fixtures.js';
import {
  checkMetrics,
  countStorageCommands,
  isStorageCommand,
  readCliFacts,
} from './metrics.js';

const MARKER: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'beta',
  cliVersion: '2.117.0',
  docker: 'available',
  sessionStartedMs: 1_000,
};

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

const ctx: Pick<LocalStackEvalContext, 'exec'> = {
  exec: async (command) =>
    command.endsWith('supabase --version')
      ? commandResult('2.117.0\n')
      : commandResult('', false),
};

const ZERO_COUNTS = {
  ls: 0,
  cp: 0,
  mv: 0,
  rm: 0,
  seedBuckets: 0,
  dbReset: 0,
  experimentalFlag: 0,
  localFlag: 0,
};

const NO_LIFECYCLE: StackLifecycle = {
  lastCommand: null,
  stoppedByAgent: false,
};

const countOf = (...commands: string[]) =>
  countStorageCommands(findSupabaseInvocations(commands));

const metricsOf = (check: { notes?: string }) =>
  JSON.parse(check.notes ?? '{}');

const throwing = <T extends object>(target: T): T =>
  new Proxy(target, {
    get() {
      throw new Error('boom');
    },
  });

describe('countStorageCommands', () => {
  it('counts nothing when no command ran', () => {
    expect(countOf()).toEqual(ZERO_COUNTS);
  });

  it('counts a recursive upload with both flags', () => {
    expect(
      countOf(
        'supabase --experimental storage cp -r ./x ss:///invoices --local'
      )
    ).toEqual({ ...ZERO_COUNTS, cp: 1, experimentalFlag: 1, localFlag: 1 });
  });

  it('counts a listing run through a versioned npx runner', () => {
    expect(
      countOf(
        'npx supabase@2.122.0 storage ls ss:///media --experimental --local'
      )
    ).toEqual({ ...ZERO_COUNTS, ls: 1, experimentalFlag: 1, localFlag: 1 });
  });

  it.each([
    ['ls', 'supabase storage ls ss:///media'],
    ['cp', 'supabase storage cp ./a.pdf ss:///invoices/a.pdf'],
    ['mv', 'supabase storage mv ss:///media/a.pdf ss:///media/b.pdf'],
    ['rm', 'supabase storage rm -r ss:///media/invoices'],
  ])('counts a storage %s only under its own field', (field, command) => {
    expect(countOf(command)).toEqual({ ...ZERO_COUNTS, [field]: 1 });
  });

  it('counts supabase seed buckets without a storage flag', () => {
    expect(countOf('supabase seed buckets')).toEqual({
      ...ZERO_COUNTS,
      seedBuckets: 1,
    });
  });

  it('counts supabase db reset', () => {
    expect(countOf('supabase db reset')).toEqual({
      ...ZERO_COUNTS,
      dbReset: 1,
    });
  });

  it('does not count a local flag on a command that is not a storage command', () => {
    expect(
      countOf('supabase seed buckets --local', 'supabase db reset --local')
    ).toEqual({ ...ZERO_COUNTS, seedBuckets: 1, dbReset: 1 });
  });

  it('counts the experimental and local flags only on storage commands', () => {
    expect(
      countOf(
        'supabase storage ls ss:///media',
        'supabase --experimental storage ls ss:///media',
        'supabase storage ls ss:///media --local',
        'supabase --experimental storage ls ss:///media --local'
      )
    ).toEqual({ ...ZERO_COUNTS, ls: 4, experimentalFlag: 2, localFlag: 2 });
  });

  it('counts a flag that is the last word of the command', () => {
    expect(
      countOf(
        'supabase storage ls ss:///media --local --experimental',
        'supabase storage ls ss:///media --experimental --local'
      )
    ).toEqual({ ...ZERO_COUNTS, ls: 2, experimentalFlag: 2, localFlag: 2 });
  });

  it('counts the =true spelling of both flags', () => {
    expect(
      countOf(
        'supabase storage ls ss:///media --experimental=true --local=true'
      )
    ).toEqual({ ...ZERO_COUNTS, ls: 1, experimentalFlag: 1, localFlag: 1 });
  });

  it('does not count flags set to false', () => {
    expect(
      countOf(
        'supabase storage ls ss:///media --experimental=false --local=false'
      )
    ).toEqual({ ...ZERO_COUNTS, ls: 1 });
  });

  it('does not count --linked as a local flag', () => {
    expect(
      countOf('supabase --experimental storage ls ss:///media --linked')
    ).toEqual({ ...ZERO_COUNTS, ls: 1, experimentalFlag: 1 });
  });

  it('finds the storage verb after a flag that takes a value', () => {
    expect(
      countOf('supabase --workdir ./app storage ls ss:///media --local')
    ).toEqual({ ...ZERO_COUNTS, ls: 1, localFlag: 1 });
  });

  it('counts every invocation of a chained command and every repeat', () => {
    expect(
      countOf(
        'supabase storage cp ./a ss:///x/a --local && supabase storage cp ./b ss:///x/b --local',
        'supabase storage rm ss:///media/a --local',
        'supabase storage cp ./c ss:///x/c --local'
      )
    ).toEqual({ ...ZERO_COUNTS, cp: 3, rm: 1, localFlag: 4 });
  });

  it('does not count a bare storage command as any verb', () => {
    expect(countOf('supabase storage')).toEqual(ZERO_COUNTS);
  });

  it('does not count a bare seed command as seeding buckets', () => {
    expect(countOf('supabase seed')).toEqual(ZERO_COUNTS);
  });

  it('does not count a path or an argument that spells a verb', () => {
    expect(countOf('supabase storage cp ./ls ss:///media/rm')).toEqual({
      ...ZERO_COUNTS,
      cp: 1,
    });
  });

  it('ignores supabase commands that are not storage, seed or db reset', () => {
    expect(
      countOf(
        'supabase start',
        'supabase stop',
        'supabase status',
        'supabase stack start',
        'supabase functions serve',
        'supabase db push',
        'supabase db pull',
        'supabase migration up'
      )
    ).toEqual(ZERO_COUNTS);
  });

  it('ignores commands that only mention storage commands or call the API directly', () => {
    expect(
      countOf(
        'echo "supabase storage ls ss:///media"',
        'ls ss:///media',
        'curl -s http://127.0.0.1:54321/storage/v1/bucket'
      )
    ).toEqual(ZERO_COUNTS);
  });
});

describe('isStorageCommand', () => {
  it.each([
    'supabase storage ls ss:///media --experimental --local',
    'supabase storage cp ./a ss:///b/a',
    'supabase storage mv ss:///a/x ss:///a/y',
    'supabase storage rm ss:///a/x',
    'supabase seed buckets',
    'supabase db reset',
    'npx supabase@2.122.0 storage ls ss:///media',
  ])('is true for %s', (command) => {
    const [invocation] = findSupabaseInvocations([command]);

    expect(isStorageCommand(invocation)).toBe(true);
  });

  it.each([
    'supabase start',
    'supabase stack status',
    'supabase db push',
    'supabase db pull',
    'supabase functions serve',
    'supabase migration up',
  ])('is false for %s', (command) => {
    const [invocation] = findSupabaseInvocations([command]);

    expect(isStorageCommand(invocation)).toBe(false);
  });
});

describe('readCliFacts', () => {
  it('reads the staged version and no override when the agent ran the installed CLI', async () => {
    const commands = ['supabase storage ls ss:///media --experimental --local'];

    expect(
      await readCliFacts(ctx, MARKER, findSupabaseInvocations(commands))
    ).toEqual({ versions: { cliVersion: '2.117.0' }, cliOverride: [] });
  });

  it('reports a version-swapping runner and a PATH version that moved', async () => {
    const moved: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async (command) =>
        command.startsWith('/usr/bin/supabase')
          ? commandResult('2.117.0\n')
          : commandResult('2.122.0\n'),
    };

    const facts = await readCliFacts(
      moved,
      MARKER,
      findSupabaseInvocations(['npx --yes supabase@2.1.0 storage ls ss:///x'])
    );

    expect(facts.versions).toEqual({
      cliVersion: '2.117.0',
      cliVersionAfterRun: '2.122.0',
    });
    expect(facts.cliOverride).toEqual(['npx --yes supabase@2.1.0']);
  });
});

describe('checkMetrics', () => {
  const baseFacts = async () => ({
    commands: [] as string[],
    invocations: findSupabaseInvocations([]),
    stack: STACK,
    keys: KEYS,
    storage: storageProbe(),
    seed: passingSeed(),
    lifecycle: NO_LIFECYCLE,
    cli: await readCliFacts(ctx, undefined, []),
  });

  it('reports every documented field and always passes', async () => {
    const commands = [
      'supabase start',
      'supabase --experimental storage cp -r ./supabase/storage/media/invoices ss:///invoices --local',
      'supabase --experimental storage rm -r ss:///media/invoices --local',
      'supabase seed buckets',
      'sudo apt-get install docker.io',
    ];
    const invocations = findSupabaseInvocations(commands);

    const check = await checkMetrics(MARKER, {
      commands,
      invocations,
      stack: { ...STACK, relocatedHome: '/home/agent/.supabase' },
      keys: KEYS,
      storage: storageProbe(),
      seed: passingSeed(),
      lifecycle: readStackLifecycle(invocations),
      cli: await readCliFacts(ctx, MARKER, invocations),
    });

    expect(check).toMatchObject({ name: 'metrics', passed: true });
    expect(metricsOf(check)).toEqual({
      cliVersion: '2.117.0',
      cliOverride: [],
      channel: 'beta',
      docker: 'available',
      stack: {
        backend: 'legacy',
        runtime: 'docker',
        relocatedHome: '/home/agent/.supabase',
      },
      keysFound: {
        serviceRole: true,
        secret: true,
        anon: true,
        publishable: true,
      },
      serviceIdentity: 'service-role',
      anonIdentity: 'anon',
      buckets: [
        { id: 'media', public: true, objects: 3 },
        { id: 'invoices', public: false, objects: 3 },
      ],
      invoiceLocations: [
        'invoices/INV-2026-0141.pdf',
        'invoices/INV-2026-0142.pdf',
        'invoices/INV-2026-0143.pdf',
      ],
      storageCommands: {
        ...ZERO_COUNTS,
        cp: 1,
        rm: 1,
        seedBuckets: 1,
        experimentalFlag: 2,
        localFlag: 2,
      },
      freshSetupInvoiceBuckets: ['invoices'],
      stackStoppedByAgent: false,
      lastStackCommand: 'supabase start',
      cliDetours: 1,
    });
  });

  it('reports stackStoppedByAgent and lastStackCommand from the lifecycle', async () => {
    const run = async (lifecycle: StackLifecycle) =>
      metricsOf(
        await checkMetrics(undefined, { ...(await baseFacts()), lifecycle })
      );

    expect(
      await run({
        lastCommand: 'supabase stop --no-backup',
        stoppedByAgent: true,
      })
    ).toMatchObject({
      stackStoppedByAgent: true,
      lastStackCommand: 'supabase stop --no-backup',
    });
    expect(
      await run({ lastCommand: 'supabase start', stoppedByAgent: false })
    ).toMatchObject({
      stackStoppedByAgent: false,
      lastStackCommand: 'supabase start',
    });
    expect(await run(NO_LIFECYCLE)).toMatchObject({
      stackStoppedByAgent: false,
      lastStackCommand: null,
    });
  });

  it('reports the pinned channel, null docker and a null relocated home when the run had no marker', async () => {
    const check = await checkMetrics(undefined, await baseFacts());

    expect(check.passed).toBe(true);
    expect(metricsOf(check)).toMatchObject({
      cliVersion: '2.117.0',
      channel: 'pinned',
      docker: null,
      stack: { backend: 'legacy', runtime: 'docker', relocatedHome: null },
      storageCommands: ZERO_COUNTS,
      cliDetours: 0,
    });
  });

  it('reports which keys the stack printed, with no key value', async () => {
    const check = await checkMetrics(undefined, {
      ...(await baseFacts()),
      keys: {
        serviceRole: KEYS.serviceRole,
        publishable: KEYS.publishable,
        anon: '  ',
      },
    });

    expect(metricsOf(check).keysFound).toEqual({
      serviceRole: true,
      secret: false,
      anon: false,
      publishable: true,
    });
    for (const key of Object.values(KEYS)) {
      expect(check.notes).not.toContain(key);
    }
  });

  it('reports no key found when the stack printed none', async () => {
    const check = await checkMetrics(undefined, {
      ...(await baseFacts()),
      keys: {},
    });

    expect(metricsOf(check).keysFound).toEqual({
      serviceRole: false,
      secret: false,
      anon: false,
      publishable: false,
    });
  });

  it('reports the identities whose control request passed', async () => {
    const check = await checkMetrics(undefined, {
      ...(await baseFacts()),
      storage: storageProbe({
        serviceIdentity: 'secret',
        anonIdentity: 'publishable',
      }),
    });

    expect(metricsOf(check)).toMatchObject({
      serviceIdentity: 'secret',
      anonIdentity: 'publishable',
    });
  });

  it('reports a null identity when no key passed its control request', async () => {
    const check = await checkMetrics(undefined, {
      ...(await baseFacts()),
      storage: storageProbe({
        control: fetched(401),
        serviceIdentity: null,
        anonControl: fetched(401),
        anonIdentity: null,
      }),
    });

    expect(metricsOf(check)).toMatchObject({
      serviceIdentity: null,
      anonIdentity: null,
    });
  });

  it('leaves out cliVersionAfterRun when the PATH version did not move', async () => {
    const check = await checkMetrics(MARKER, await baseFacts());

    expect(metricsOf(check)).not.toHaveProperty('cliVersionAfterRun');
  });

  it('lists each place an invoice is stored as bucket/key, including a copy left in media', async () => {
    const check = await checkMetrics(undefined, {
      ...(await baseFacts()),
      storage: storageProbe({
        objects: [
          ...mediaAvatars(),
          ...INVOICES.map((file) => mediaInvoiceHeld(file)),
          ...movedInvoices(),
        ],
      }),
    });

    const metrics = metricsOf(check);
    expect(metrics.invoiceLocations).toEqual([
      'media/invoices/INV-2026-0141.pdf',
      'media/invoices/INV-2026-0142.pdf',
      'media/invoices/INV-2026-0143.pdf',
      'invoices/INV-2026-0141.pdf',
      'invoices/INV-2026-0142.pdf',
      'invoices/INV-2026-0143.pdf',
    ]);
    expect(metrics.buckets).toEqual([
      { id: 'media', public: true, objects: 6 },
      { id: 'invoices', public: false, objects: 3 },
    ]);
  });

  it('lists no invoice location and an empty bucket count once the invoices are gone', async () => {
    const check = await checkMetrics(undefined, {
      ...(await baseFacts()),
      storage: storageProbe({ objects: mediaAvatars() }),
    });

    expect(metricsOf(check)).toMatchObject({
      invoiceLocations: [],
      buckets: [
        { id: 'media', public: true, objects: 3 },
        { id: 'invoices', public: false, objects: 0 },
      ],
    });
  });

  it('does not list an object whose bytes could not be read as an invoice location', async () => {
    const [first] = movedInvoices();
    const check = await checkMetrics(undefined, {
      ...(await baseFacts()),
      storage: storageProbe({
        objects: [
          ...mediaAvatars(),
          { ...first, service: { status: 400, sha256: null } },
        ],
      }),
    });

    expect(metricsOf(check).invoiceLocations).toEqual([]);
  });

  it.each([
    ['a project as seeded', untouchedSeed(), ['media']],
    ['a project with a private invoices bucket', passingSeed(), ['invoices']],
    [
      'a project with the invoice seed files deleted',
      seedProbe(bucketSeeding(MEDIA_BUCKET, true, AVATARS)),
      [],
    ],
    [
      'a project that seeds invoices into two buckets',
      seedProbe(
        bucketSeeding(MEDIA_BUCKET, true, [...AVATARS, INVOICES[0]]),
        bucketSeeding('invoices', false, INVOICES)
      ),
      ['media', 'invoices'],
    ],
  ])(
    'lists the declared buckets that seed invoices for %s',
    async (_name, seed, expected) => {
      const check = await checkMetrics(undefined, {
        ...(await baseFacts()),
        seed,
      });

      expect(metricsOf(check).freshSetupInvoiceBuckets).toEqual(expected);
    }
  );

  it('reports the storage commands the invocations ran', async () => {
    const commands = [
      'supabase storage ls ss:///media --experimental --local',
      'supabase storage cp ./a ss:///invoices/a --experimental --local',
      'supabase db reset',
      'supabase seed buckets',
    ];

    const check = await checkMetrics(undefined, {
      ...(await baseFacts()),
      commands,
      invocations: findSupabaseInvocations(commands),
    });

    expect(metricsOf(check).storageCommands).toEqual({
      ...ZERO_COUNTS,
      ls: 1,
      cp: 1,
      dbReset: 1,
      seedBuckets: 1,
      experimentalFlag: 2,
      localFlag: 2,
    });
  });

  it('counts the commands a detour pattern matches', async () => {
    const commands = [
      'supabase start',
      'sudo apt-get install docker.io',
      'sudo systemctl start docker',
    ];

    const check = await checkMetrics(undefined, {
      ...(await baseFacts()),
      commands,
      invocations: findSupabaseInvocations(commands),
    });

    expect(metricsOf(check).cliDetours).toBe(2);
  });

  it('still passes with null probe fields when the stack, the storage probe and the config are unavailable', async () => {
    const check = await checkMetrics(undefined, {
      ...(await baseFacts()),
      stack: { ok: false, notes: 'The local stack is not running.' },
      storage: { ok: false, notes: 'The local stack is not running.' },
      seed: { ok: false, notes: 'ENOENT: supabase/config.toml' },
    });

    expect(check).toMatchObject({ name: 'metrics', passed: true });
    expect(metricsOf(check)).toMatchObject({
      stack: { backend: 'none', runtime: 'none', relocatedHome: null },
      buckets: null,
      serviceIdentity: null,
      anonIdentity: null,
      invoiceLocations: null,
      freshSetupInvoiceBuckets: null,
      storageCommands: ZERO_COUNTS,
    });
  });

  it('reports a null version instead of failing when the sandbox is gone', async () => {
    const failing: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async () => {
        throw new Error('sandbox gone');
      },
    };

    const check = await checkMetrics(undefined, {
      ...(await baseFacts()),
      cli: await readCliFacts(failing, undefined, []),
    });

    expect(check.passed).toBe(true);
    expect(metricsOf(check)).toMatchObject({ cliVersion: null });
  });

  it('reports a version-swapping runner and a PATH version that moved', async () => {
    const moved: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async (command) =>
        command.startsWith('/usr/bin/supabase')
          ? commandResult('2.117.0\n')
          : commandResult('2.122.0\n'),
    };
    const commands = ['npx --yes supabase@2.1.0 storage ls ss:///media'];
    const invocations = findSupabaseInvocations(commands);

    const check = await checkMetrics(MARKER, {
      ...(await baseFacts()),
      commands,
      invocations,
      cli: await readCliFacts(moved, MARKER, invocations),
    });

    expect(metricsOf(check)).toMatchObject({
      cliVersion: '2.117.0',
      cliVersionAfterRun: '2.122.0',
      cliOverride: ['npx --yes supabase@2.1.0'],
      storageCommands: { ...ZERO_COUNTS, ls: 1 },
    });
  });

  it('keeps the database credentials out of the notes', async () => {
    const check = await checkMetrics(MARKER, await baseFacts());

    expect(check.notes).not.toContain('postgres:postgres');
  });

  it('turns a field whose input throws into null without failing the others', async () => {
    const facts = await baseFacts();

    const hostileStorage = await checkMetrics(undefined, {
      ...facts,
      storage: throwing(storageProbe()),
    });
    expect(hostileStorage.passed).toBe(true);
    expect(metricsOf(hostileStorage)).toMatchObject({
      buckets: null,
      serviceIdentity: null,
      anonIdentity: null,
      keysFound: expect.any(Object),
      invoiceLocations: null,
      freshSetupInvoiceBuckets: ['invoices'],
      stack: { backend: 'legacy' },
    });

    const hostileSeed = await checkMetrics(undefined, {
      ...facts,
      seed: throwing(passingSeed()),
    });
    expect(hostileSeed.passed).toBe(true);
    expect(metricsOf(hostileSeed)).toMatchObject({
      freshSetupInvoiceBuckets: null,
      invoiceLocations: INVOICES.map(({ key }) => `invoices/${basename(key)}`),
    });

    const hostileLifecycle = await checkMetrics(undefined, {
      ...facts,
      lifecycle: throwing({ ...NO_LIFECYCLE }),
    });
    expect(hostileLifecycle.passed).toBe(true);
    expect(metricsOf(hostileLifecycle)).toMatchObject({
      stackStoppedByAgent: null,
      lastStackCommand: null,
      buckets: expect.any(Array),
    });

    const hostileKeys = await checkMetrics(undefined, {
      ...facts,
      keys: throwing({ ...KEYS }),
    });
    expect(hostileKeys.passed).toBe(true);
    expect(metricsOf(hostileKeys)).toMatchObject({
      keysFound: null,
      serviceIdentity: 'service-role',
      buckets: expect.any(Array),
    });

    const hostileStack = await checkMetrics(undefined, {
      ...facts,
      stack: throwing({ ...STACK }),
    });
    expect(hostileStack.passed).toBe(true);
    expect(metricsOf(hostileStack)).toMatchObject({
      stack: null,
      buckets: expect.any(Array),
    });

    const hostileInvocations = await checkMetrics(undefined, {
      ...facts,
      invocations: throwing(findSupabaseInvocations([])),
    });
    expect(hostileInvocations.passed).toBe(true);
    expect(metricsOf(hostileInvocations)).toMatchObject({
      storageCommands: null,
      cliDetours: 0,
      buckets: expect.any(Array),
    });

    const hostileCommands = await checkMetrics(undefined, {
      ...facts,
      commands: throwing([] as string[]),
    });
    expect(hostileCommands.passed).toBe(true);
    expect(metricsOf(hostileCommands)).toMatchObject({
      cliDetours: null,
      storageCommands: ZERO_COUNTS,
      buckets: expect.any(Array),
    });
  });
});
