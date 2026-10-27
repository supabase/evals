import { describe, expect, it } from 'vitest';
import type { StackProbe } from '../lib/stack.js';
import type { StackKeys } from '../lib/stack-keys.js';
import type { StackLifecycle } from '../lib/cli-invocations.js';
import {
  ANON,
  API_URL,
  avatarRows,
  basename,
  CONTROL_URL,
  copyLeftWorld,
  createSandbox,
  DB_URL,
  failed,
  fetched,
  type Held,
  invoiceHeld,
  invoiceRows,
  KEY_VALUES,
  KEYS,
  LEGACY_NOT_PROBED,
  LEGACY_NOT_RUNNING,
  legacyRunning,
  MANAGED_STACK,
  MEDIA,
  mediaAvatars,
  mediaInvoiceHeld,
  movedInvoices,
  ok,
  originalReads,
  passingWorld,
  PRIVATE_INVOICES,
  PUBLISHABLE,
  SECRET_KEY,
  SERVICE_ROLE,
  served,
  STACK,
  storageProbe,
  untouchedWorld,
  urlFor,
  type Intercept,
  type World,
} from './fakes.js';
import { AVATARS, INVOICES, MEDIA_BUCKET, type SeedFile } from './fixtures.js';
import {
  anonHeaderSets,
  checkAvatarsPublic,
  checkInvoicesPrivate,
  checkNoInvoicePublic,
  fetchObject,
  LEGACY_STATUS_COMMAND,
  objectUrl,
  probeLegacyStack,
  probeStorage,
  readStorageRows,
  serviceHeaderSets,
  type LegacyStackProbe,
  type StorageProbe,
} from './storage.js';

const PRIVATE = 'invoices are in a private bucket on the local stack';
const NOT_PUBLIC = 'no invoice is publicly readable on the local stack';
const AVATARS_PUBLIC = 'avatars are still public where the app loads them';

const SERVICE_HEADERS = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
};
const ANON_HEADERS = { apikey: ANON, Authorization: `Bearer ${ANON}` };

const OTHER_SHA = 'f'.repeat(64);

const STOPPED: StackLifecycle = {
  lastCommand: 'supabase stop --no-backup',
  stoppedByAgent: true,
};
const STARTED: StackLifecycle = {
  lastCommand: 'supabase start',
  stoppedByAgent: false,
};
const UNAVAILABLE: Extract<StorageProbe, { ok: false }> = {
  ok: false,
  notes: 'no local stack: The local stack is not running',
};
const STOP_PREFIX =
  'the agent stopped the stack (last stack command: `supabase stop --no-backup`); storage probe unavailable: ';

function okProbe(probe: StorageProbe) {
  if (!probe.ok) throw new Error(`storage probe unavailable: ${probe.notes}`);
  return probe;
}

const heldBy = (probe: StorageProbe, bucket: string, key: string) =>
  okProbe(probe).objects.find(
    (object) => object.bucket === bucket && object.key === key
  );

function expectSameMembers<T>(actual: readonly T[], expected: readonly T[]) {
  expect(actual).toHaveLength(expected.length);
  expect(actual).toEqual(expect.arrayContaining<unknown>([...expected]));
}

async function run(
  world: World | undefined,
  options: {
    keys?: StackKeys;
    stack?: StackProbe;
    intercept?: Intercept;
  } = {}
) {
  const sandbox = createSandbox({ world, intercept: options.intercept });
  const result = await probeStorage(
    sandbox.ctx,
    options.stack ?? STACK,
    options.keys ?? KEYS
  );
  return { ...sandbox, result };
}

const without = (objects: Held[], file: SeedFile) =>
  objects.filter((held) => held.key !== basename(file.key));

describe('serviceHeaderSets', () => {
  it('offers the service-role JWT as apikey and bearer, then the secret key as apikey', () => {
    expect(serviceHeaderSets(KEYS)).toEqual([
      { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` },
      { apikey: SECRET_KEY },
    ]);
  });

  it('offers only the secret key when the stack prints no service-role JWT', () => {
    expect(serviceHeaderSets({ secret: SECRET_KEY, anon: ANON })).toEqual([
      { apikey: SECRET_KEY },
    ]);
  });

  it('offers only the JWT when the stack prints no secret key', () => {
    expect(serviceHeaderSets({ serviceRole: SERVICE_ROLE })).toEqual([
      SERVICE_HEADERS,
    ]);
  });

  it('offers nothing without keys', () => {
    expect(serviceHeaderSets({})).toEqual([]);
  });

  it('treats blank keys as missing', () => {
    expect(serviceHeaderSets({ serviceRole: '', secret: '' })).toEqual([]);
  });

  it('never offers the anon or publishable key as a service identity', () => {
    expect(serviceHeaderSets({ anon: ANON, publishable: PUBLISHABLE })).toEqual(
      []
    );
  });
});

describe('anonHeaderSets', () => {
  it('offers the anon JWT as apikey and bearer, then the publishable key as apikey', () => {
    expect(anonHeaderSets(KEYS)).toEqual([
      { apikey: ANON, Authorization: `Bearer ${ANON}` },
      { apikey: PUBLISHABLE },
    ]);
  });

  it('offers only the publishable key when the stack prints no anon JWT', () => {
    expect(
      anonHeaderSets({ publishable: PUBLISHABLE, secret: SECRET_KEY })
    ).toEqual([{ apikey: PUBLISHABLE }]);
  });

  it('offers only the JWT when the stack prints no publishable key', () => {
    expect(anonHeaderSets({ anon: ANON })).toEqual([ANON_HEADERS]);
  });

  it('offers nothing without keys', () => {
    expect(anonHeaderSets({})).toEqual([]);
  });

  it('treats blank keys as missing', () => {
    expect(anonHeaderSets({ anon: '', publishable: '' })).toEqual([]);
  });

  it('never offers the service-role or secret key as an anon identity', () => {
    expect(
      anonHeaderSets({ serviceRole: SERVICE_ROLE, secret: SECRET_KEY })
    ).toEqual([]);
  });
});

describe('objectUrl', () => {
  it('addresses a service read under /storage/v1/object/<bucket>/<key>', () => {
    expect(objectUrl(API_URL, 'service', 'media', 'avatars/ava.svg')).toBe(
      'http://127.0.0.1:54321/storage/v1/object/media/avatars/ava.svg'
    );
  });

  it('addresses a public read under /storage/v1/object/public/<bucket>/<key>', () => {
    expect(objectUrl(API_URL, 'public', 'media', 'avatars/ava.svg')).toBe(
      'http://127.0.0.1:54321/storage/v1/object/public/media/avatars/ava.svg'
    );
  });

  it.each([
    [
      'spaces',
      'invoices/2026 Q1/INV 0141.pdf',
      'invoices/2026%20Q1/INV%200141.pdf',
    ],
    ['a hash', 'invoices/#1.pdf', 'invoices/%231.pdf'],
    ['a question mark', 'invoices/what?.pdf', 'invoices/what%3F.pdf'],
    ['unicode', 'invoices/café/Zoë.pdf', 'invoices/caf%C3%A9/Zo%C3%AB.pdf'],
    ['a percent sign', 'invoices/100%.pdf', 'invoices/100%25.pdf'],
    ['a plus and an ampersand', 'invoices/a+b&c.pdf', 'invoices/a%2Bb%26c.pdf'],
  ])('percent-encodes %s in a key', (_name, key, encoded) => {
    expect(objectUrl(API_URL, 'service', 'media', key)).toBe(
      `${API_URL}/storage/v1/object/media/${encoded}`
    );
    expect(objectUrl(API_URL, 'public', 'media', key)).toBe(
      `${API_URL}/storage/v1/object/public/media/${encoded}`
    );
  });

  it('keeps one slash between the segments of a nested key', () => {
    expect(objectUrl(API_URL, 'service', 'media', 'a/b/c/d.txt')).toBe(
      `${API_URL}/storage/v1/object/media/a/b/c/d.txt`
    );
  });

  it('percent-encodes the bucket name', () => {
    expect(objectUrl(API_URL, 'service', 'my bucket', 'x.txt')).toBe(
      `${API_URL}/storage/v1/object/my%20bucket/x.txt`
    );
  });

  it('builds a URL the storage API resolves back to the same bucket and key', async () => {
    const key = '2026 Q1/INV #1? café 100%.pdf';
    const { ctx } = createSandbox({
      world: {
        buckets: [PRIVATE_INVOICES],
        objects: [{ bucket: 'invoices', key, sha256: INVOICES[0].sha256 }],
      },
    });

    expect(
      await fetchObject(
        ctx,
        objectUrl(API_URL, 'service', 'invoices', key),
        SERVICE_HEADERS
      )
    ).toEqual({ status: 200, sha256: INVOICES[0].sha256 });
  });
});

describe('fetchObject', () => {
  const url = urlFor('service', 'invoices', 'INV-2026-0141.pdf');

  it('runs one command that names the URL and sends the header values', async () => {
    const { ctx, commands } = createSandbox({ world: passingWorld() });

    await fetchObject(ctx, url, SERVICE_HEADERS);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(url);
    expect(commands[0]).toContain(SERVICE_ROLE);
    expect(commands[0]).toContain(`Bearer ${SERVICE_ROLE}`);
  });

  it('returns the status and the hash of the downloaded bytes for a 200', async () => {
    const { ctx } = createSandbox({ world: passingWorld() });

    expect(await fetchObject(ctx, url, SERVICE_HEADERS)).toEqual({
      status: 200,
      sha256: INVOICES[0].sha256,
    });
  });

  it('sends no credentials when given no headers', async () => {
    const { ctx, commands, requests } = createSandbox({
      world: passingWorld(),
    });

    await fetchObject(ctx, urlFor('public', MEDIA_BUCKET, AVATARS[0].key), {});

    for (const key of KEY_VALUES) expect(commands[0]).not.toContain(key);
    expect(requests.map(({ identity }) => identity)).toEqual(['none']);
  });

  it('sends only the headers it is given', async () => {
    const { ctx, requests } = createSandbox({ world: passingWorld() });

    await fetchObject(ctx, url, { apikey: SECRET_KEY });

    expect(requests.map(({ identity }) => identity)).toEqual(['secret']);
  });

  it('drops the hash of an error body so a 400 never looks like invoice bytes', async () => {
    const { ctx } = createSandbox({
      world: {
        buckets: [PRIVATE_INVOICES],
        objects: [
          {
            bucket: 'invoices',
            key: 'INV-2026-0141.pdf',
            sha256: INVOICES[0].sha256,
            bytes: false,
          },
        ],
      },
    });

    expect(await fetchObject(ctx, url, SERVICE_HEADERS)).toEqual({
      status: 400,
      sha256: null,
    });
  });

  it.each([
    [200, true],
    [204, true],
    [299, true],
    [199, false],
    [300, false],
    [302, false],
    [400, false],
    [404, false],
    [500, false],
  ])(
    'keeps the hash for status %i only when it is 2xx (%s)',
    async (status, kept) => {
      const { ctx } = createSandbox({
        intercept: () => ok(`${status} ${INVOICES[0].sha256}\n`),
      });

      expect(await fetchObject(ctx, url, SERVICE_HEADERS)).toEqual({
        status,
        sha256: kept ? INVOICES[0].sha256 : null,
      });
    }
  );

  it('reports no status and the error when the sandbox throws', async () => {
    const { ctx } = createSandbox({ intercept: () => 'throw' });

    const result = await fetchObject(ctx, url, SERVICE_HEADERS);

    expect(result.status).toBeNull();
    expect(result.sha256).toBeNull();
    expect(result.notes).toContain('sandbox gone');
  });

  it('reports no status and the curl error when the command fails', async () => {
    const { ctx } = createSandbox({
      intercept: () =>
        failed('curl: (7) Failed to connect to 127.0.0.1 port 54321', 7),
    });

    const result = await fetchObject(ctx, url, SERVICE_HEADERS);

    expect(result.status).toBeNull();
    expect(result.sha256).toBeNull();
    expect(result.notes).toContain('Failed to connect');
  });

  it.each([
    ['prose', '<html><body>502 Bad Gateway</body></html>'],
    ['empty output', ''],
    ['a status without a hash', '200'],
    ['a hash without a status', INVOICES[0].sha256],
  ])('reports no status and a note for %s', async (_name, stdout) => {
    const { ctx } = createSandbox({ intercept: () => ok(stdout) });

    const result = await fetchObject(ctx, url, SERVICE_HEADERS);

    expect(result.status).toBeNull();
    expect(result.sha256).toBeNull();
    expect(result.notes).toMatch(/\S/);
  });
});

describe('readStorageRows', () => {
  const rows = {
    buckets: [
      { id: 'media', public: true },
      { id: 'invoices', public: false },
    ],
    objects: [
      { bucket: 'media', name: 'avatars/ava.svg' },
      { bucket: 'invoices', name: 'INV-2026-0141.pdf' },
    ],
  };
  const json = JSON.stringify(rows);

  it('runs one psql query over storage.objects against the database URL', async () => {
    const { ctx, commands } = createSandbox({ world: passingWorld() });

    await readStorageRows(ctx, DB_URL);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('psql');
    expect(commands[0]).toContain(DB_URL);
    expect(commands[0]).toContain('storage.objects');
  });

  it('returns the buckets and the objects with their name as key', async () => {
    const { ctx } = createSandbox({ intercept: () => ok(`${json}\n`) });

    expect(await readStorageRows(ctx, DB_URL)).toEqual({
      ok: true,
      buckets: rows.buckets,
      objects: [
        { bucket: 'media', key: 'avatars/ava.svg' },
        { bucket: 'invoices', key: 'INV-2026-0141.pdf' },
      ],
    });
  });

  it('reads the rows of a stack that holds them', async () => {
    const { ctx } = createSandbox({ world: copyLeftWorld() });

    const result = await readStorageRows(ctx, DB_URL);

    expect(result).toMatchObject({
      ok: true,
      buckets: expect.arrayContaining([MEDIA, PRIVATE_INVOICES]),
      objects: expect.arrayContaining([
        { bucket: 'media', key: 'invoices/INV-2026-0142.pdf' },
      ]),
    });
    expect(result).toHaveProperty('buckets.length', 2);
    expect(result).toHaveProperty(
      'objects.length',
      AVATARS.length + INVOICES.length * 2
    );
  });

  it('accepts the JSON line surrounded by whitespace', async () => {
    const { ctx } = createSandbox({ intercept: () => ok(`\n  ${json}  \n\n`) });

    expect(await readStorageRows(ctx, DB_URL)).toMatchObject({
      ok: true,
      buckets: rows.buckets,
    });
  });

  it('keeps keys with spaces, unicode and slashes as they are', async () => {
    const name = 'invoices/2026 Q1/café #1.pdf';
    const { ctx } = createSandbox({
      intercept: () =>
        ok(
          JSON.stringify({
            buckets: [{ id: 'media', public: true }],
            objects: [{ bucket: 'media', name }],
          })
        ),
    });

    expect(await readStorageRows(ctx, DB_URL)).toMatchObject({
      objects: [{ bucket: 'media', key: name }],
    });
  });

  it('treats a bucket whose public flag is null as private', async () => {
    const { ctx } = createSandbox({
      intercept: () =>
        ok(
          JSON.stringify({
            buckets: [
              { id: 'legacy', public: null },
              { id: 'media', public: true },
            ],
            objects: [],
          })
        ),
    });

    expect(await readStorageRows(ctx, DB_URL)).toEqual({
      ok: true,
      buckets: [
        { id: 'legacy', public: false },
        { id: 'media', public: true },
      ],
      objects: [],
    });
  });

  it('drops object rows with a null name or bucket and keeps the rest', async () => {
    const { ctx } = createSandbox({
      intercept: () =>
        ok(
          JSON.stringify({
            buckets: [{ id: 'media', public: true }],
            objects: [
              { bucket: 'media', name: null },
              { bucket: null, name: 'orphan.pdf' },
              { bucket: null, name: null },
              { bucket: 'media', name: 'avatars/ava.svg' },
            ],
          })
        ),
    });

    expect(await readStorageRows(ctx, DB_URL)).toEqual({
      ok: true,
      buckets: [{ id: 'media', public: true }],
      objects: [{ bucket: 'media', key: 'avatars/ava.svg' }],
    });
  });

  it('returns empty lists for a stack without buckets or objects', async () => {
    const { ctx } = createSandbox({
      intercept: () => ok('{"buckets":[],"objects":[]}\n'),
    });

    expect(await readStorageRows(ctx, DB_URL)).toEqual({
      ok: true,
      buckets: [],
      objects: [],
    });
  });

  it('reports the psql error when the query fails', async () => {
    const { ctx } = createSandbox({
      intercept: () =>
        failed(
          'psql: error: connection to server at "127.0.0.1", port 54322 failed: Connection refused',
          2
        ),
    });

    const result = await readStorageRows(ctx, DB_URL);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      notes: expect.stringContaining('Connection refused'),
    });
  });

  it('reports the error when the sandbox throws', async () => {
    const { ctx } = createSandbox({ intercept: () => 'throw' });

    expect(await readStorageRows(ctx, DB_URL)).toEqual({
      ok: false,
      notes: expect.stringContaining('sandbox gone'),
    });
  });

  it.each([
    ['prose', 'ERROR:  relation "storage.objects" does not exist'],
    ['empty output', ''],
    ['null', 'null'],
    ['an array', '[]'],
    ['no objects list', '{"buckets":[]}'],
    ['no buckets list', '{"objects":[]}'],
    [
      'a bucket with no id',
      '{"buckets":[{"id":null,"public":true}],"objects":[]}',
    ],
    [
      'a bucket whose public flag is a string',
      '{"buckets":[{"id":"media","public":"yes"}],"objects":[]}',
    ],
    [
      'an object whose name is a number',
      '{"buckets":[],"objects":[{"bucket":"media","name":1}]}',
    ],
  ])(
    'fails closed on %s instead of reporting an empty stack',
    async (_name, stdout) => {
      const { ctx } = createSandbox({ intercept: () => ok(stdout) });

      const result = await readStorageRows(ctx, DB_URL);

      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ notes: expect.stringMatching(/\S/) });
    }
  );
});

describe('probeStorage', () => {
  it('lists the buckets and downloads every object with the service key', async () => {
    const { result, requests } = await run(passingWorld());

    const probe = okProbe(result);
    expect(probe.apiUrl).toBe(API_URL);
    expectSameMembers(probe.buckets, [MEDIA, PRIVATE_INVOICES]);
    expect(probe.objects).toHaveLength(AVATARS.length + INVOICES.length);
    for (const avatar of AVATARS) {
      expect(heldBy(probe, 'media', avatar.key)).toMatchObject({
        bucketPublic: true,
        service: { status: 200, sha256: avatar.sha256 },
      });
    }
    for (const invoice of INVOICES) {
      const key = basename(invoice.key);
      expect(heldBy(probe, 'invoices', key)).toMatchObject({
        bucketPublic: false,
        service: { status: 200, sha256: invoice.sha256 },
      });
      expect(
        requests.some(
          (request) =>
            request.kind === 'service' &&
            request.identity === 'service' &&
            request.bucket === 'invoices' &&
            request.key === key
        )
      ).toBe(true);
    }
  });

  it('asks the storage API for the bucket list as the service role to prove it is reachable', async () => {
    const { result, requests, commands } = await run(passingWorld());

    expect(okProbe(result).control).toMatchObject({ status: 200 });
    const control = requests.filter(({ kind }) => kind === 'control');
    expect(control.length).toBeGreaterThanOrEqual(1);
    expect(control[0].identity).toBe('service');
    expect(commands.some((command) => command.includes(CONTROL_URL))).toBe(
      true
    );
  });

  it('reads objects in public buckets by their public URL without credentials', async () => {
    const { result, requests } = await run(passingWorld());

    const probe = okProbe(result);
    for (const avatar of AVATARS) {
      expect(heldBy(probe, 'media', avatar.key)?.public).toEqual({
        status: 200,
        sha256: avatar.sha256,
      });
    }
    const publicReads = requests.filter(({ kind }) => kind === 'public');
    expect(publicReads.length).toBeGreaterThan(0);
    expect(publicReads.every(({ identity }) => identity === 'none')).toBe(true);
  });

  it('leaves non-invoice objects in private buckets without a public read', async () => {
    const world = passingWorld();
    world.objects.push({
      bucket: 'invoices',
      key: 'notes.txt',
      sha256: OTHER_SHA,
    });

    const { result } = await run(world);

    expect(heldBy(result, 'invoices', 'notes.txt')?.public).toBeUndefined();
  });

  it('reads an invoice in a private bucket by its public URL and records the denial', async () => {
    const { result, requests } = await run(passingWorld());

    for (const invoice of INVOICES) {
      expect(heldBy(result, 'invoices', basename(invoice.key))?.public).toEqual(
        { status: 400, sha256: null }
      );
    }
    expect(checkNoInvoicePublic(result).passed).toBe(true);
    expect(
      requests.filter(
        ({ kind, bucket }) => kind === 'public' && bucket === 'invoices'
      )
    ).toHaveLength(INVOICES.length);
  });

  it('records a 2xx on the public URL of an invoice in a private bucket and fails the public-read check', async () => {
    const target = urlFor('public', 'invoices', 'INV-2026-0141.pdf');

    const { result } = await run(passingWorld(), {
      intercept: (kind, _call, command) =>
        kind === 'curl' && command.includes(target)
          ? ok(`200 ${INVOICES[0].sha256}\n`)
          : undefined,
    });

    expect(heldBy(result, 'invoices', 'INV-2026-0141.pdf')).toMatchObject({
      bucketPublic: false,
      public: { status: 200, sha256: INVOICES[0].sha256 },
    });
    expect(checkNoInvoicePublic(result)).toMatchObject({
      passed: false,
      notes: expect.stringContaining(
        'invoices/INV-2026-0141.pdf is readable by its public URL'
      ),
    });
  });

  it('reads only invoice-holding objects as the anon role and records the denial without a hash', async () => {
    const { result, requests } = await run(passingWorld());

    const probe = okProbe(result);
    for (const invoice of INVOICES) {
      expect(heldBy(probe, 'invoices', basename(invoice.key))?.anon).toEqual({
        status: 400,
        sha256: null,
      });
    }
    for (const avatar of AVATARS) {
      expect(heldBy(probe, 'media', avatar.key)?.anon).toBeUndefined();
    }
    const anonReads = requests.filter(
      ({ kind, identity }) =>
        kind === 'service' &&
        (identity === 'anon' || identity === 'publishable')
    );
    expect(anonReads.length).toBeGreaterThan(0);
    expect(
      anonReads.every(
        ({ bucket, key }) =>
          bucket === 'invoices' && INVOICES.some((i) => basename(i.key) === key)
      )
    ).toBe(true);
  });

  it('never sends a service key on an anon read or an anon key on a service read', async () => {
    const { requests } = await run(copyLeftWorld());

    const objectReads = requests.filter(({ kind }) => kind === 'service');
    const anonReads = objectReads.filter(
      ({ identity }) => identity === 'anon' || identity === 'publishable'
    );
    const serviceReads = objectReads.filter(
      ({ identity }) => identity === 'service' || identity === 'secret'
    );
    expect(anonReads.length).toBeGreaterThan(0);
    expect(serviceReads.length).toBeGreaterThan(0);
    expect(anonReads.length + serviceReads.length).toBe(objectReads.length);
    for (const { command } of anonReads) {
      expect(command).not.toContain(SERVICE_ROLE);
      expect(command).not.toContain(SECRET_KEY);
    }
    for (const { command } of serviceReads) {
      expect(command).not.toContain(ANON);
      expect(command).not.toContain(PUBLISHABLE);
    }
  });

  it('reads invoice copies in a public bucket by public URL and as the anon role', async () => {
    const { result } = await run(copyLeftWorld());

    const copy = heldBy(result, 'media', 'invoices/INV-2026-0141.pdf');
    expect(copy).toMatchObject({
      bucketPublic: true,
      service: { status: 200, sha256: INVOICES[0].sha256 },
      public: { status: 200, sha256: INVOICES[0].sha256 },
      anon: { status: 400, sha256: null },
    });
  });

  it('records an anon read that a storage policy allows, with the bytes it returned', async () => {
    const { result } = await run({
      ...passingWorld(),
      anonReads: (bucket) => bucket === 'invoices',
    });

    expect(heldBy(result, 'invoices', 'INV-2026-0141.pdf')?.anon).toEqual({
      status: 200,
      sha256: INVOICES[0].sha256,
    });
  });

  it('reads the anon role through the publishable key when the stack prints no anon JWT', async () => {
    const { result, requests } = await run(
      { ...passingWorld(), anonReads: () => true },
      { keys: { ...KEYS, anon: undefined } }
    );

    expect(heldBy(result, 'invoices', 'INV-2026-0142.pdf')?.anon).toEqual({
      status: 200,
      sha256: INVOICES[1].sha256,
    });
    expect(requests.some(({ identity }) => identity === 'anon')).toBe(false);
  });

  it('reads each original media/invoices key and each avatar by public URL without credentials', async () => {
    const { result, requests } = await run(passingWorld());

    const probe = okProbe(result);
    expect(Object.keys(probe.originalInvoices).sort()).toEqual(
      INVOICES.map(({ key }) => key).sort()
    );
    for (const invoice of INVOICES) {
      expect(probe.originalInvoices[invoice.key]).toEqual({
        status: 404,
        sha256: null,
      });
    }
    expect(Object.keys(probe.avatars).sort()).toEqual(
      AVATARS.map(({ key }) => key).sort()
    );
    for (const avatar of AVATARS) {
      expect(probe.avatars[avatar.key]).toEqual({
        status: 200,
        sha256: avatar.sha256,
      });
    }
    for (const invoice of INVOICES) {
      expect(
        requests.some(
          ({ kind, bucket, key, identity }) =>
            kind === 'public' &&
            bucket === 'media' &&
            key === invoice.key &&
            identity === 'none'
        )
      ).toBe(true);
    }
  });

  it('finds an original invoice still readable at its media URL', async () => {
    const { result } = await run(copyLeftWorld());

    const probe = okProbe(result);
    for (const invoice of INVOICES) {
      expect(probe.originalInvoices[invoice.key]).toEqual({
        status: 200,
        sha256: invoice.sha256,
      });
    }
  });

  it('finds the avatars unreadable once the media bucket is private', async () => {
    const world: World = {
      ...passingWorld(),
      buckets: [{ id: 'media', public: false }, PRIVATE_INVOICES],
    };

    const { result } = await run(world);

    const probe = okProbe(result);
    for (const avatar of AVATARS) {
      expect(probe.avatars[avatar.key]).toEqual({ status: 400, sha256: null });
    }
    expect(heldBy(probe, 'media', AVATARS[0].key)?.bucketPublic).toBe(false);
  });

  it('records an object whose row exists but whose bytes are gone as an unreadable download', async () => {
    const world: World = {
      ...passingWorld(),
      objects: [
        ...avatarRows(),
        ...INVOICES.map((file) => ({
          bucket: 'invoices',
          key: basename(file.key),
          sha256: file.sha256,
          bytes: false,
        })),
      ],
    };

    const { result } = await run(world);

    expect(heldBy(result, 'invoices', 'INV-2026-0141.pdf')?.service).toEqual({
      status: 400,
      sha256: null,
    });
  });

  it('reads keys with spaces, a hash and unicode through the API', async () => {
    const key = '2026 Q1/INV #1 café.pdf';
    const { result } = await run({
      buckets: [PRIVATE_INVOICES],
      objects: [{ bucket: 'invoices', key, sha256: INVOICES[0].sha256 }],
    });

    expect(heldBy(result, 'invoices', key)?.service).toEqual({
      status: 200,
      sha256: INVOICES[0].sha256,
    });
  });

  it('keeps the probe when one download throws and marks only that object unread', async () => {
    const target = urlFor('service', 'invoices', 'INV-2026-0142.pdf');

    const { result } = await run(passingWorld(), {
      intercept: (kind, _call, command) =>
        kind === 'curl' && command.includes(target) ? 'throw' : undefined,
    });

    const probe = okProbe(result);
    const unread = heldBy(probe, 'invoices', 'INV-2026-0142.pdf')?.service;
    expect(unread?.status).toBeNull();
    expect(unread?.sha256).toBeNull();
    expect(unread?.notes).toContain('sandbox gone');
    expect(heldBy(probe, 'invoices', 'INV-2026-0141.pdf')?.service).toEqual({
      status: 200,
      sha256: INVOICES[0].sha256,
    });
  });

  it('probes a stack with no buckets and no objects', async () => {
    const { result } = await run({ buckets: [], objects: [] });

    const probe = okProbe(result);
    expect(probe.buckets).toEqual([]);
    expect(probe.objects).toEqual([]);
    expect(probe.control).toMatchObject({ status: 200 });
    for (const avatar of AVATARS) {
      expect(probe.avatars[avatar.key].status).not.toBe(200);
    }
    for (const invoice of INVOICES) {
      expect(probe.originalInvoices[invoice.key].status).not.toBe(200);
    }
  });

  describe('choosing the service identity', () => {
    it('keeps the service-role JWT and never tries the secret key when the control request passes', async () => {
      const { result, requests } = await run(passingWorld());

      expect(okProbe(result).control).toMatchObject({ status: 200 });
      expect(okProbe(result).serviceIdentity).toBe('service-role');
      expect(requests.some(({ identity }) => identity === 'secret')).toBe(
        false
      );
    });

    it('falls back to the secret key when the service-role JWT fails the control request', async () => {
      const { result, requests } = await run({
        ...passingWorld(),
        accepts: ['secret'],
      });

      const probe = okProbe(result);
      expect(probe.control).toMatchObject({ status: 200 });
      expect(probe.serviceIdentity).toBe('secret');
      expect(
        requests
          .filter(
            ({ kind, identity }) =>
              kind === 'control' &&
              (identity === 'service' || identity === 'secret')
          )
          .map(({ identity }) => identity)
      ).toEqual(['service', 'secret']);
      const downloads = requests.filter(
        ({ kind, identity }) =>
          kind === 'service' &&
          (identity === 'service' || identity === 'secret')
      );
      expect(downloads.length).toBeGreaterThan(0);
      expect(downloads.every(({ identity }) => identity === 'secret')).toBe(
        true
      );
      expect(heldBy(probe, 'invoices', 'INV-2026-0141.pdf')?.service).toEqual({
        status: 200,
        sha256: INVOICES[0].sha256,
      });
    });

    it('keeps the last control result and downloads with the first key set when none passes', async () => {
      const { result, requests } = await run({
        ...passingWorld(),
        accepts: [],
        controlStatus: { service: 403, secret: 401 },
      });

      const probe = okProbe(result);
      expect(probe.control).toMatchObject({ status: 401 });
      expect(probe.serviceIdentity).toBeNull();
      const downloads = requests.filter(
        ({ kind, identity }) =>
          kind === 'service' &&
          (identity === 'service' || identity === 'secret')
      );
      expect(downloads.length).toBeGreaterThan(0);
      expect(downloads.every(({ identity }) => identity === 'service')).toBe(
        true
      );
      expect(heldBy(probe, 'invoices', 'INV-2026-0141.pdf')?.service).toEqual({
        status: 401,
        sha256: null,
      });
    });

    it('proves nothing without keys: it sends no credentials and no check passes', async () => {
      const { result, requests } = await run(passingWorld(), { keys: {} });

      expect(requests.every(({ identity }) => identity === 'none')).toBe(true);
      expect(checkInvoicesPrivate(result).passed).toBe(false);
      expect(checkNoInvoicePublic(result).passed).toBe(false);
    });

    it('says no service key could be read when the stack status holds none', async () => {
      const { result } = await run(passingWorld(), {
        keys: { anon: ANON, publishable: PUBLISHABLE },
      });

      const probe = okProbe(result);
      expect(probe.serviceIdentity).toBeNull();
      expect(probe.control.status).toBeNull();
      expect(checkNoInvoicePublic(result).notes).toContain(
        'no service key could be read from the stack status'
      );
    });
  });

  describe('choosing the anon identity', () => {
    const controlsOf = (
      requests: ReturnType<typeof createSandbox>['requests']
    ) =>
      requests
        .filter(({ kind }) => kind === 'control')
        .map(({ identity }) => identity);

    it('sends the anon control request to the bucket list and keeps the anon JWT when it gets a 200', async () => {
      const { result, requests, commands } = await run(passingWorld());

      const probe = okProbe(result);
      expect(probe.anonControl).toMatchObject({ status: 200 });
      expect(probe.anonIdentity).toBe('anon');
      expect(controlsOf(requests)).toEqual(['service', 'anon']);
      expect(
        commands.filter((command) => command.includes(CONTROL_URL))
      ).toHaveLength(2);
    });

    it('falls back to the publishable key when the anon JWT fails the control request, and reads with it', async () => {
      const { result, requests } = await run({
        ...passingWorld(),
        controlStatus: { anon: 401 },
        anonReads: () => true,
      });

      const probe = okProbe(result);
      expect(controlsOf(requests)).toEqual(['service', 'anon', 'publishable']);
      expect(probe.anonControl).toMatchObject({ status: 200 });
      expect(probe.anonIdentity).toBe('publishable');
      const reads = requests.filter(
        ({ kind, identity }) =>
          kind === 'service' &&
          (identity === 'anon' || identity === 'publishable')
      );
      expect(reads.length).toBe(INVOICES.length);
      expect(reads.every(({ identity }) => identity === 'publishable')).toBe(
        true
      );
      expect(heldBy(probe, 'invoices', 'INV-2026-0141.pdf')?.anon).toEqual({
        status: 200,
        sha256: INVOICES[0].sha256,
      });
    });

    it('reads each invoice-holding object once, with the identity that passed', async () => {
      const { requests } = await run(passingWorld());

      const reads = requests.filter(
        ({ kind, identity }) =>
          kind === 'service' &&
          (identity === 'anon' || identity === 'publishable')
      );
      expect(reads).toHaveLength(INVOICES.length);
      expect(reads.every(({ identity }) => identity === 'anon')).toBe(true);
    });

    it('keeps the last anon control result and reads with the first anon key set when none passes', async () => {
      const { result, requests } = await run({
        ...passingWorld(),
        rejectsAnon: true,
        anonReads: () => true,
      });

      const probe = okProbe(result);
      expect(probe.anonControl).toMatchObject({ status: 401 });
      expect(probe.anonIdentity).toBeNull();
      expect(controlsOf(requests)).toEqual(['service', 'anon', 'publishable']);
      expect(heldBy(probe, 'invoices', 'INV-2026-0141.pdf')?.anon).toEqual({
        status: 401,
        sha256: null,
      });
    });

    it('sends no anon request and says no anon key could be read when the stack status holds none', async () => {
      const { result, requests } = await run(
        { ...passingWorld(), anonReads: () => true },
        { keys: { serviceRole: SERVICE_ROLE, secret: SECRET_KEY } }
      );

      const probe = okProbe(result);
      expect(probe.anonIdentity).toBeNull();
      expect(probe.anonControl).toMatchObject({
        status: null,
        notes: expect.stringContaining('no anon key could be read'),
      });
      expect(controlsOf(requests)).toEqual(['service']);
      expect(
        heldBy(probe, 'invoices', 'INV-2026-0141.pdf')?.anon
      ).toBeUndefined();
    });

    it('never sends a service key on an anon control request', async () => {
      const { requests } = await run(passingWorld());

      for (const { command } of requests.filter(
        ({ kind, identity }) => kind === 'control' && identity === 'anon'
      )) {
        expect(command).not.toContain(SERVICE_ROLE);
        expect(command).not.toContain(SECRET_KEY);
      }
    });
  });

  describe('when the stack cannot be probed', () => {
    it('reports the stack failure and runs nothing when no stack resolved', async () => {
      const { result, commands } = await run(passingWorld(), {
        stack: { ok: false, notes: 'The local stack is not running' },
      });

      expect(result).toEqual({
        ok: false,
        notes: expect.stringContaining('The local stack is not running'),
      });
      expect(commands).toEqual([]);
    });

    it('reports a reason and sends no request when the stack has no API URL', async () => {
      const { result, requests } = await run(passingWorld(), {
        stack: { ...STACK, apiUrl: undefined },
      });

      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ notes: expect.stringMatching(/\S/) });
      expect(requests).toEqual([]);
    });

    it('reports the psql error and sends no request when the rows cannot be read', async () => {
      const { result, requests } = await run(passingWorld(), {
        intercept: (kind) =>
          kind === 'psql'
            ? failed('psql: error: Connection refused', 2)
            : undefined,
      });

      expect(result).toEqual({
        ok: false,
        notes: expect.stringContaining('Connection refused'),
      });
      expect(requests).toEqual([]);
    });
  });
});

describe('probeLegacyStack', () => {
  const LEGACY_STATUS = 'SUPABASE_EXPERIMENTAL_STACK=0 supabase status -o json';
  const MANAGED_NAMED: StackProbe = {
    ...MANAGED_STACK,
    backend: 'managed-named',
  };

  async function probeLegacy(
    stack: StackProbe,
    options: {
      world?: World;
      legacyKeys?: string | null;
      intercept?: Intercept;
    } = {}
  ) {
    const sandbox = createSandbox({
      world: options.world ?? untouchedWorld(),
      legacyKeys: options.legacyKeys,
      intercept: options.intercept,
    });
    const result = await probeLegacyStack(sandbox.ctx, stack);
    return { ...sandbox, result };
  }

  const curlCommands = (commands: readonly string[]) =>
    commands.filter((command) => command.includes('curl'));

  const stillInMedia = (count: number): World => ({
    buckets: [MEDIA],
    objects: [
      ...avatarRows(),
      ...invoiceRows(MEDIA_BUCKET, (file) => file.key).slice(0, count),
    ],
  });

  it('names the command the harness started the stack with', () => {
    expect(LEGACY_STATUS_COMMAND).toBe(LEGACY_STATUS);
  });

  it('is not probed and runs no command when no stack resolved', async () => {
    const { result, commands } = await probeLegacy({
      ok: false,
      notes: 'The local stack is not running',
    });

    expect(result).toEqual({ probed: false });
    expect(commands).toEqual([]);
  });

  it('is not probed and runs no command when the scored stack is the legacy one', async () => {
    const { result, commands } = await probeLegacy(STACK);

    expect(result).toEqual({ probed: false });
    expect(commands).toEqual([]);
  });

  it('reads the status of the legacy stack with exactly the harness command and nothing before it', async () => {
    const { commands } = await probeLegacy(MANAGED_STACK);

    expect(commands[0]).toBe(LEGACY_STATUS);
  });

  it('reads the public URL of every original invoice key on the legacy API when a managed stack was scored', async () => {
    const { result, commands } = await probeLegacy(MANAGED_STACK);

    expect(result).toEqual({
      probed: true,
      running: true,
      apiUrl: API_URL,
      originalInvoices: Object.fromEntries(
        INVOICES.map(({ key, sha256 }) => [key, served(sha256)])
      ),
    });
    expect(commands).toHaveLength(1 + INVOICES.length);
    for (const { key } of INVOICES) {
      expect(
        commands.some((command) =>
          command.includes(urlFor('public', MEDIA_BUCKET, key))
        )
      ).toBe(true);
    }
  });

  it('probes a named managed stack the same way', async () => {
    const { result } = await probeLegacy(MANAGED_NAMED);

    expect(result).toMatchObject({
      probed: true,
      running: true,
      apiUrl: API_URL,
    });
  });

  it('sends the reads without an API key or any header', async () => {
    const { commands, requests } = await probeLegacy(MANAGED_STACK);

    const reads = curlCommands(commands);
    expect(reads).toHaveLength(INVOICES.length);
    for (const command of reads) {
      for (const key of KEY_VALUES) expect(command).not.toContain(key);
      expect(command).not.toMatch(/apikey|authorization|\s-H\s/i);
    }
    expect(requests).toHaveLength(INVOICES.length);
    for (const { key } of INVOICES) {
      expect(requests).toContainEqual(
        expect.objectContaining({
          kind: 'public',
          identity: 'none',
          bucket: MEDIA_BUCKET,
          key,
        })
      );
    }
  });

  it('sends the same fetch commands as the original-invoice reads of the scored stack', async () => {
    const { commands } = await probeLegacy(MANAGED_STACK);
    const expected = createSandbox({ world: untouchedWorld() });
    for (const { key } of INVOICES) {
      await fetchObject(expected.ctx, urlFor('public', MEDIA_BUCKET, key), {});
    }

    expect([...curlCommands(commands)].sort()).toEqual(
      [...expected.commands].sort()
    );
  });

  it('records which original keys the legacy stack still serves', async () => {
    const { result } = await probeLegacy(MANAGED_STACK, {
      world: stillInMedia(1),
    });

    expect(result).toEqual({
      probed: true,
      running: true,
      apiUrl: API_URL,
      originalInvoices: {
        ...originalReads([404, 404, 404]),
        [INVOICES[0].key]: served(INVOICES[0].sha256),
      },
    });
  });

  it('records the denial when the legacy media bucket is private', async () => {
    const { result } = await probeLegacy(MANAGED_STACK, {
      world: {
        buckets: [{ id: MEDIA_BUCKET, public: false }],
        objects: invoiceRows(MEDIA_BUCKET, (file) => file.key),
      },
    });

    expect(result).toMatchObject({
      running: true,
      originalInvoices: originalReads([400, 400, 400]),
    });
  });

  it('keeps a read that failed as no status and still reports the stack running', async () => {
    const target = urlFor('public', MEDIA_BUCKET, INVOICES[1].key);

    const { result } = await probeLegacy(MANAGED_STACK, {
      intercept: (kind, _call, command) =>
        kind === 'curl' && command.includes(target)
          ? failed('curl: (7) Failed to connect', 7)
          : undefined,
    });

    expect(result).toMatchObject({ probed: true, running: true });
    const reads = (result as Extract<LegacyStackProbe, { running: true }>)
      .originalInvoices;
    expect(reads[INVOICES[1].key]).toEqual({
      status: null,
      sha256: null,
      notes: expect.stringContaining('Failed to connect'),
    });
    expect(reads[INVOICES[0].key]).toEqual(served(INVOICES[0].sha256));
    expect(reads[INVOICES[2].key]).toEqual(served(INVOICES[2].sha256));
  });

  it('reports the legacy stack not running, with the failure, and sends no read when its status fails', async () => {
    const { result, commands } = await probeLegacy(MANAGED_STACK, {
      legacyKeys: null,
      intercept: (kind) =>
        kind === 'keys' ? failed('no such container') : undefined,
    });

    expect(result).toEqual({
      probed: true,
      running: false,
      notes: 'exit 1: no such container',
    });
    expect(commands).toEqual([LEGACY_STATUS]);
  });

  it('reports the legacy stack not running, with the error message, when the command throws', async () => {
    const { result, commands } = await probeLegacy(MANAGED_STACK, {
      intercept: (kind) => (kind === 'keys' ? 'throw' : undefined),
    });

    expect(result).toEqual({
      probed: true,
      running: false,
      notes: 'sandbox gone',
    });
    expect(curlCommands(commands)).toEqual([]);
  });

  it('reports the legacy stack not running when its status prints no API URL', async () => {
    const { result, commands } = await probeLegacy(MANAGED_STACK, {
      legacyKeys: '{}',
    });

    expect(result).toEqual({
      probed: true,
      running: false,
      notes: 'exit 0: {}',
    });
    expect(curlCommands(commands)).toEqual([]);
  });

  it('is not probed, and reads nothing, when the legacy status points at the API the scored stack answered on', async () => {
    const { result, commands } = await probeLegacy({
      ...MANAGED_STACK,
      apiUrl: API_URL,
    });

    expect(result).toEqual({ probed: false });
    expect(commands).toEqual([LEGACY_STATUS]);
  });

  it('keeps every API key out of the probe', async () => {
    const running = await probeLegacy(MANAGED_STACK);
    const stopped = await probeLegacy(MANAGED_STACK, {
      legacyKeys: null,
      intercept: (kind) => (kind === 'keys' ? failed('exited') : undefined),
    });

    for (const { result } of [running, stopped]) {
      for (const key of KEY_VALUES) {
        expect(JSON.stringify(result)).not.toContain(key);
      }
    }
  });
});

describe('checkInvoicesPrivate', () => {
  it('passes when every invoice sits, byte for byte, in a private bucket', () => {
    expect(checkInvoicesPrivate(storageProbe())).toMatchObject({
      name: PRIVATE,
      passed: true,
    });
  });

  it.each<[string, (file: SeedFile) => string]>([
    ['customer-invoices', (file) => basename(file.key)],
    ['private', (file) => file.key],
    ['archive', (file) => `2026/${basename(file.key)}`],
  ])(
    'passes for a private bucket named %s however the keys are laid out',
    (bucket, keyFor) => {
      const probe = storageProbe({
        buckets: [MEDIA, { id: bucket, public: false }],
        objects: [
          ...mediaAvatars(),
          ...INVOICES.map((file) =>
            invoiceHeld(file, { bucket, key: keyFor(file) })
          ),
        ],
      });

      expect(checkInvoicesPrivate(probe).passed).toBe(true);
    }
  );

  it('passes when the invoices are spread over several private buckets', () => {
    const probe = storageProbe({
      buckets: [MEDIA, PRIVATE_INVOICES, { id: 'archive', public: false }],
      objects: [
        ...mediaAvatars(),
        invoiceHeld(INVOICES[0]),
        invoiceHeld(INVOICES[1], { bucket: 'archive' }),
        invoiceHeld(INVOICES[2], { bucket: 'archive' }),
      ],
    });

    expect(checkInvoicesPrivate(probe).passed).toBe(true);
  });

  it('passes while a copy also remains in the public bucket, leaving that to the public-read check', () => {
    const probe = storageProbe({
      objects: [
        ...mediaAvatars(),
        ...movedInvoices(),
        ...INVOICES.map((file) => mediaInvoiceHeld(file)),
      ],
    });

    expect(checkInvoicesPrivate(probe).passed).toBe(true);
  });

  it('fails when the invoices are still only in the public bucket', () => {
    const probe = storageProbe({
      buckets: [MEDIA],
      objects: [
        ...mediaAvatars(),
        ...INVOICES.map((file) => mediaInvoiceHeld(file)),
      ],
    });

    expect(checkInvoicesPrivate(probe)).toMatchObject({
      name: PRIVATE,
      passed: false,
    });
  });

  it('fails when the object rows were moved but their bytes cannot be downloaded', () => {
    const probe = storageProbe({
      objects: [
        ...mediaAvatars(),
        ...INVOICES.map((file) => ({
          ...invoiceHeld(file),
          service: fetched(400),
        })),
      ],
    });

    expect(checkInvoicesPrivate(probe).passed).toBe(false);
  });

  it('fails when the invoices were deleted', () => {
    const probe = storageProbe({ objects: mediaAvatars() });

    expect(checkInvoicesPrivate(probe).passed).toBe(false);
  });

  it('fails when one invoice is missing and names it', () => {
    const probe = storageProbe({
      objects: [...mediaAvatars(), ...without(movedInvoices(), INVOICES[1])],
    });

    const check = checkInvoicesPrivate(probe);

    expect(check.passed).toBe(false);
    expect(check.notes).toContain('INV-2026-0142');
  });

  it('fails when an invoice arrived with different bytes', () => {
    const probe = storageProbe({
      objects: [
        ...mediaAvatars(),
        ...without(movedInvoices(), INVOICES[2]),
        {
          ...invoiceHeld(INVOICES[2]),
          service: served(OTHER_SHA),
        },
      ],
    });

    expect(checkInvoicesPrivate(probe).passed).toBe(false);
  });

  it('fails when one invoice is stored several times and the others not at all', () => {
    const probe = storageProbe({
      objects: [
        ...mediaAvatars(),
        invoiceHeld(INVOICES[0], { key: 'a.pdf' }),
        invoiceHeld(INVOICES[0], { key: 'b.pdf' }),
        invoiceHeld(INVOICES[0], { key: 'c.pdf' }),
      ],
    });

    expect(checkInvoicesPrivate(probe).passed).toBe(false);
  });

  it('fails when the only copy of an invoice sits in a public bucket', () => {
    const probe = storageProbe({
      objects: [
        ...mediaAvatars(),
        ...without(movedInvoices(), INVOICES[0]),
        mediaInvoiceHeld(INVOICES[0]),
      ],
    });

    expect(checkInvoicesPrivate(probe).passed).toBe(false);
  });

  it('fails with the probe notes when the storage probe is unavailable', () => {
    const check = checkInvoicesPrivate({
      ok: false,
      notes: 'The local stack is not running',
    });

    expect(check).toMatchObject({ name: PRIVATE, passed: false });
    expect(check.notes).toContain('The local stack is not running');
  });

  it('prefixes the unavailable notes with the stop when the agent stopped the stack', () => {
    const check = checkInvoicesPrivate(UNAVAILABLE, STOPPED);

    expect(check.passed).toBe(false);
    expect(check.notes).toBe(`${STOP_PREFIX}${UNAVAILABLE.notes}`);
  });

  it('leaves the unavailable notes unprefixed when the agent left the stack started or ran no stack command', () => {
    for (const lifecycle of [STARTED, undefined]) {
      expect(checkInvoicesPrivate(UNAVAILABLE, lifecycle).notes).toBe(
        `storage probe unavailable: ${UNAVAILABLE.notes}`
      );
    }
  });

  it('ignores the stop when the storage probe is available', () => {
    expect(checkInvoicesPrivate(storageProbe(), STOPPED)).toEqual(
      checkInvoicesPrivate(storageProbe())
    );
  });
});

describe('checkNoInvoicePublic', () => {
  it('passes when the invoices are only in a private bucket and the media bucket holds avatars', () => {
    expect(checkNoInvoicePublic(storageProbe())).toMatchObject({
      name: NOT_PUBLIC,
      passed: true,
    });
  });

  it('passes while the public bucket holds other files than avatars', () => {
    const probe = storageProbe({
      objects: [
        ...mediaAvatars(),
        ...movedInvoices(),
        {
          bucket: 'media',
          key: 'docs/readme.txt',
          service: served(OTHER_SHA),
          public: served(OTHER_SHA),
        },
      ],
    });

    expect(checkNoInvoicePublic(probe).passed).toBe(true);
  });

  it('passes when the invoices were deleted everywhere and the original URLs return 404', () => {
    expect(
      checkNoInvoicePublic(storageProbe({ objects: mediaAvatars() })).passed
    ).toBe(true);
  });

  it('fails when a copy is left in the public bucket', () => {
    const probe = storageProbe({
      objects: [
        ...mediaAvatars(),
        ...movedInvoices(),
        mediaInvoiceHeld(INVOICES[1]),
      ],
      originalInvoices: {
        ...storageProbe().originalInvoices,
        [INVOICES[1].key]: served(INVOICES[1].sha256),
      },
    });

    expect(checkNoInvoicePublic(probe)).toMatchObject({
      name: NOT_PUBLIC,
      passed: false,
    });
  });

  it('fails when an invoice was uploaded to another public bucket', () => {
    const probe = storageProbe({
      buckets: [MEDIA, PRIVATE_INVOICES, { id: 'public-docs', public: true }],
      objects: [
        ...mediaAvatars(),
        ...movedInvoices(),
        invoiceHeld(INVOICES[2], {
          bucket: 'public-docs',
          key: 'receipt.bin',
          public: served(INVOICES[2].sha256),
        }),
      ],
    });

    expect(checkNoInvoicePublic(probe).passed).toBe(false);
  });

  it('fails for invoice bytes in a public bucket even when the public read did not return them', () => {
    const probe = storageProbe({
      objects: [
        ...mediaAvatars(),
        ...movedInvoices(),
        {
          bucket: 'media',
          key: 'invoices/INV-2026-0141.pdf',
          service: served(INVOICES[0].sha256),
          public: fetched(400),
        },
      ],
    });

    expect(checkNoInvoicePublic(probe).passed).toBe(false);
  });

  it('fails for invoice bytes in a public bucket that only the public read returned', () => {
    const probe = storageProbe({
      objects: [
        ...mediaAvatars(),
        ...movedInvoices(),
        {
          bucket: 'media',
          key: 'invoices/INV-2026-0141.pdf',
          service: fetched(400),
          public: served(INVOICES[0].sha256),
        },
      ],
    });

    expect(checkNoInvoicePublic(probe).passed).toBe(false);
  });

  it.each([
    ['an error status', fetched(400)],
    ['no status', { status: null, sha256: null, notes: 'sandbox gone' }],
  ])(
    'fails for an object in a public bucket whose bytes could not be read (%s)',
    (_name, unread) => {
      const probe = storageProbe({
        objects: [
          ...mediaAvatars(),
          ...movedInvoices(),
          {
            bucket: 'media',
            key: 'misc/unknown.bin',
            service: unread,
            public: unread,
          },
        ],
      });

      expect(checkNoInvoicePublic(probe).passed).toBe(false);
    }
  );

  it('fails when a private bucket lets the anon role read an invoice', () => {
    const probe = storageProbe({
      objects: [
        ...mediaAvatars(),
        invoiceHeld(INVOICES[0], { anon: served(INVOICES[0].sha256) }),
        invoiceHeld(INVOICES[1]),
        invoiceHeld(INVOICES[2]),
      ],
    });

    expect(checkNoInvoicePublic(probe).passed).toBe(false);
  });

  it('fails when the public URL of an invoice answers with a 2xx even though its bucket row says private', () => {
    const probe = storageProbe({
      objects: [
        ...mediaAvatars(),
        invoiceHeld(INVOICES[0], { public: served(INVOICES[0].sha256) }),
        invoiceHeld(INVOICES[1]),
        invoiceHeld(INVOICES[2]),
      ],
    });

    expect(checkNoInvoicePublic(probe).passed).toBe(false);
  });

  it('fails when an original media/invoices URL still answers with a 2xx', () => {
    const probe = storageProbe({
      objects: [...mediaAvatars(), ...movedInvoices()],
      originalInvoices: {
        ...storageProbe().originalInvoices,
        [INVOICES[2].key]: served(INVOICES[2].sha256),
      },
    });

    expect(checkNoInvoicePublic(probe).passed).toBe(false);
  });

  it.each([
    ['answers 401', fetched(401)],
    [
      'cannot connect',
      { status: null, sha256: null, notes: 'curl: (7) Failed to connect' },
    ],
  ])(
    'fails without a passing control request because the storage API %s',
    (_name, control) => {
      const check = checkNoInvoicePublic(storageProbe({ control }));

      expect(check).toMatchObject({ name: NOT_PUBLIC, passed: false });
      expect(check.notes).toMatch(/\S/);
    }
  );

  it.each([
    ['answers 401', fetched(401), 'returned 401'],
    [
      'was never sent',
      { status: null, sha256: null, notes: 'no anon key could be read' },
      'no anon key could be read',
    ],
  ])(
    'fails when an invoice exists and the anon control request %s, since anon reads prove nothing',
    (_name, anonControl, detail) => {
      const check = checkNoInvoicePublic(storageProbe({ anonControl }));

      expect(check).toMatchObject({ name: NOT_PUBLIC, passed: false });
      expect(check.notes).toContain(
        'the anon key was not accepted, so anon reads prove nothing'
      );
      expect(check.notes).toContain(detail);
    }
  );

  it('ignores a failed anon control request when no object holds an invoice', () => {
    expect(
      checkNoInvoicePublic(
        storageProbe({
          objects: mediaAvatars(),
          anonControl: fetched(401),
          anonIdentity: null,
        })
      ).passed
    ).toBe(true);
  });

  it('fails when an invoice-holding object has no anon read, naming it', () => {
    const [first, ...rest] = movedInvoices();
    const unread = {
      bucket: first.bucket,
      key: first.key,
      service: first.service,
    };

    const check = checkNoInvoicePublic(
      storageProbe({ objects: [...mediaAvatars(), unread, ...rest] })
    );

    expect(check.passed).toBe(false);
    expect(check.notes).toContain('invoices/INV-2026-0141.pdf');
    expect(check.notes).toContain('no anon read');
  });

  it('fails with the probe notes when the storage probe is unavailable', () => {
    const check = checkNoInvoicePublic({
      ok: false,
      notes: 'The local stack is not running',
    });

    expect(check).toMatchObject({ name: NOT_PUBLIC, passed: false });
    expect(check.notes).toContain('The local stack is not running');
  });

  it('prefixes the unavailable notes with the stop when the agent stopped the stack', () => {
    const check = checkNoInvoicePublic(UNAVAILABLE, STOPPED);

    expect(check.passed).toBe(false);
    expect(check.notes).toBe(`${STOP_PREFIX}${UNAVAILABLE.notes}`);
  });

  it('leaves the unavailable notes unprefixed when the agent left the stack started or ran no stack command', () => {
    for (const lifecycle of [STARTED, undefined]) {
      expect(checkNoInvoicePublic(UNAVAILABLE, lifecycle).notes).toBe(
        `storage probe unavailable: ${UNAVAILABLE.notes}`
      );
    }
  });

  it('ignores the stop when the storage probe is available', () => {
    expect(checkNoInvoicePublic(storageProbe(), STOPPED)).toEqual(
      checkNoInvoicePublic(storageProbe())
    );
  });

  describe('against the legacy stack the harness started', () => {
    const LEGACY_NOTE = (key: string, apiUrl = API_URL) =>
      `media/${key} is still publicly readable on the legacy stack the harness started (${apiUrl})`;

    it('fails naming the key and the legacy stack when one original read there is 200', () => {
      const check = checkNoInvoicePublic(
        storageProbe(),
        undefined,
        legacyRunning([404, 200, 404])
      );

      expect(check).toEqual({
        name: NOT_PUBLIC,
        passed: false,
        notes: LEGACY_NOTE(INVOICES[1].key),
      });
    });

    it('names every key the legacy stack still serves and no other', () => {
      const check = checkNoInvoicePublic(
        storageProbe(),
        STARTED,
        legacyRunning([200, 400, 200])
      );

      expect(check.passed).toBe(false);
      expect(check.notes).toBe(
        [LEGACY_NOTE(INVOICES[0].key), LEGACY_NOTE(INVOICES[2].key)].join('; ')
      );
    });

    it('names the legacy API URL the reads were made on', () => {
      const check = checkNoInvoicePublic(
        storageProbe(),
        undefined,
        legacyRunning([200, 404, 404], 'http://127.0.0.1:55321')
      );

      expect(check.notes).toBe(
        LEGACY_NOTE(INVOICES[0].key, 'http://127.0.0.1:55321')
      );
    });

    it('adds its problem to the problems of the scored stack', () => {
      const scored = storageProbe({
        objects: [
          ...mediaAvatars(),
          ...movedInvoices(),
          mediaInvoiceHeld(INVOICES[1]),
        ],
        originalInvoices: {
          ...storageProbe().originalInvoices,
          [INVOICES[1].key]: served(INVOICES[1].sha256),
        },
      });

      const check = checkNoInvoicePublic(
        scored,
        undefined,
        legacyRunning([200, 404, 404])
      );

      expect(check.notes).toContain(
        `media/${INVOICES[1].key} is still publicly readable`
      );
      expect(check.notes).toContain(LEGACY_NOTE(INVOICES[0].key));
    });

    it.each([
      [199, false],
      [200, true],
      [204, true],
      [299, true],
      [300, false],
      [302, false],
      [400, false],
      [404, false],
      [500, false],
      [null, false],
    ])(
      'treats a legacy original read of %s as public: %s',
      (status, public_) => {
        const check = checkNoInvoicePublic(
          storageProbe(),
          undefined,
          legacyRunning([status, 404, 404])
        );

        expect(check.passed).toBe(!public_);
      }
    );

    it.each([
      ['every original read is 400', legacyRunning([400, 400, 400])],
      ['every original read is 404', legacyRunning([404, 404, 404])],
      ['no original read got a response', legacyRunning([null, null, null])],
      ['the legacy stack is not running', LEGACY_NOT_RUNNING],
      ['the legacy stack was not probed', LEGACY_NOT_PROBED],
    ])('matches the two-argument result when %s', (_name, legacy) => {
      expect(checkNoInvoicePublic(storageProbe(), undefined, legacy)).toEqual(
        checkNoInvoicePublic(storageProbe())
      );
      expect(
        checkNoInvoicePublic(storageProbe(), undefined, legacy).passed
      ).toBe(true);
    });

    it('does not change a failing result when the legacy stack serves nothing', () => {
      const probe = storageProbe({ objects: mediaAvatars() });
      const failing = checkNoInvoicePublic({
        ...probe,
        control: fetched(401),
      });

      expect(failing.passed).toBe(false);
      expect(
        checkNoInvoicePublic(
          { ...probe, control: fetched(401) },
          undefined,
          legacyRunning([404, 404, 404])
        )
      ).toEqual(failing);
    });

    it('ignores the legacy stack when the storage probe is unavailable', () => {
      expect(
        checkNoInvoicePublic(
          UNAVAILABLE,
          STOPPED,
          legacyRunning([200, 200, 200])
        )
      ).toEqual(checkNoInvoicePublic(UNAVAILABLE, STOPPED));
      expect(
        checkNoInvoicePublic(
          UNAVAILABLE,
          undefined,
          legacyRunning([200, 200, 200])
        ).notes
      ).not.toContain('legacy stack');
    });
  });
});

describe('checkAvatarsPublic', () => {
  it('passes when every avatar is publicly readable with its original bytes', () => {
    expect(checkAvatarsPublic(storageProbe())).toMatchObject({
      name: AVATARS_PUBLIC,
      passed: true,
    });
  });

  it('passes when the avatars were re-seeded with the same bytes', () => {
    const probe = storageProbe({
      objects: [...mediaAvatars().reverse(), ...movedInvoices()],
    });

    expect(checkAvatarsPublic(probe).passed).toBe(true);
  });

  it('passes whatever happened to the invoices', () => {
    const probe = storageProbe({
      objects: mediaAvatars(),
      originalInvoices: Object.fromEntries(
        INVOICES.map(({ key, sha256 }) => [key, served(sha256)])
      ),
    });

    expect(checkAvatarsPublic(probe).passed).toBe(true);
  });

  it('fails when the media bucket was made private', () => {
    const probe = storageProbe({
      buckets: [{ id: 'media', public: false }, PRIVATE_INVOICES],
      objects: [
        ...AVATARS.map((file) => ({
          bucket: 'media',
          key: file.key,
          service: served(file.sha256),
        })),
        ...movedInvoices(),
      ],
      avatars: Object.fromEntries(
        AVATARS.map(({ key }) => [key, fetched(400)])
      ),
    });

    expect(checkAvatarsPublic(probe)).toMatchObject({
      name: AVATARS_PUBLIC,
      passed: false,
    });
  });

  it('fails when the buckets were wiped', () => {
    const probe = storageProbe({
      buckets: [],
      objects: [],
      avatars: Object.fromEntries(
        AVATARS.map(({ key }) => [key, fetched(404)])
      ),
    });

    expect(checkAvatarsPublic(probe).passed).toBe(false);
  });

  it('fails when one avatar is gone and names it', () => {
    const probe = storageProbe({
      avatars: {
        ...storageProbe().avatars,
        [AVATARS[2].key]: fetched(404),
      },
    });

    const check = checkAvatarsPublic(probe);

    expect(check.passed).toBe(false);
    expect(check.notes).toContain(AVATARS[2].key);
  });

  it('fails when an avatar has other bytes than the seeded ones', () => {
    const probe = storageProbe({
      avatars: {
        ...storageProbe().avatars,
        [AVATARS[0].key]: served(OTHER_SHA),
      },
    });

    expect(checkAvatarsPublic(probe).passed).toBe(false);
  });

  it('fails when an avatar answers 200 without a hash to compare', () => {
    const probe = storageProbe({
      avatars: {
        ...storageProbe().avatars,
        [AVATARS[1].key]: fetched(200),
      },
    });

    expect(checkAvatarsPublic(probe).passed).toBe(false);
  });

  it('fails when an avatar was never probed', () => {
    const [first, second] = AVATARS;
    const probe = storageProbe({
      avatars: {
        [first.key]: served(first.sha256),
        [second.key]: served(second.sha256),
      },
    });

    expect(checkAvatarsPublic(probe).passed).toBe(false);
  });

  it('fails with the probe notes when the storage probe is unavailable', () => {
    const check = checkAvatarsPublic({
      ok: false,
      notes: 'The local stack is not running',
    });

    expect(check).toMatchObject({ name: AVATARS_PUBLIC, passed: false });
    expect(check.notes).toContain('The local stack is not running');
  });

  it('prefixes the unavailable notes with the stop when the agent stopped the stack', () => {
    const check = checkAvatarsPublic(UNAVAILABLE, STOPPED);

    expect(check.passed).toBe(false);
    expect(check.notes).toBe(`${STOP_PREFIX}${UNAVAILABLE.notes}`);
  });

  it('leaves the unavailable notes unprefixed when the agent left the stack started or ran no stack command', () => {
    for (const lifecycle of [STARTED, undefined]) {
      expect(checkAvatarsPublic(UNAVAILABLE, lifecycle).notes).toBe(
        `storage probe unavailable: ${UNAVAILABLE.notes}`
      );
    }
  });

  it('ignores the stop when the storage probe is available', () => {
    expect(checkAvatarsPublic(storageProbe(), STOPPED)).toEqual(
      checkAvatarsPublic(storageProbe())
    );
  });
});

describe('the checks against a probed stack', () => {
  const verdicts = async (world: World) => {
    const { result } = await run(world);
    return [
      checkInvoicesPrivate(result).passed,
      checkNoInvoicePublic(result).passed,
      checkAvatarsPublic(result).passed,
    ];
  };

  it('passes all three for invoices moved to a private bucket', async () => {
    expect(await verdicts(passingWorld())).toEqual([true, true, true]);
  });

  it('fails the first two when nothing was moved', async () => {
    expect(await verdicts(untouchedWorld())).toEqual([false, false, true]);
  });

  it('fails only the public-read check when the invoices were copied and not moved', async () => {
    expect(await verdicts(copyLeftWorld())).toEqual([true, false, true]);
  });

  it('fails only the public-read check when a policy lets the anon role read the private bucket', async () => {
    expect(
      await verdicts({ ...passingWorld(), anonReads: () => true })
    ).toEqual([true, false, true]);
  });

  it('fails only the private-bucket check when the rows moved but the bytes did not', async () => {
    const world = passingWorld();
    world.objects = world.objects.map((object) =>
      object.bucket === 'invoices' ? { ...object, bytes: false } : object
    );

    expect(await verdicts(world)).toEqual([false, true, true]);
  });

  it('fails the public-read check when the anon key is rejected outright, even where a policy would have allowed the read', async () => {
    expect(
      await verdicts({
        ...passingWorld(),
        rejectsAnon: true,
        anonReads: () => true,
      })
    ).toEqual([true, false, true]);
  });

  it('fails the public-read check when the stack status holds no anon key', async () => {
    const { result } = await run(passingWorld(), {
      keys: { serviceRole: SERVICE_ROLE, secret: SECRET_KEY },
    });

    expect(checkNoInvoicePublic(result)).toMatchObject({
      passed: false,
      notes: expect.stringContaining('the anon key was not accepted'),
    });
  });

  it('passes the public-read check without an anon key when no object holds an invoice', async () => {
    const world: World = {
      buckets: [MEDIA],
      objects: avatarRows(),
    };
    const { result } = await run(world, {
      keys: { serviceRole: SERVICE_ROLE, secret: SECRET_KEY },
    });

    expect(checkNoInvoicePublic(result).passed).toBe(true);
  });

  it('fails the last when the media bucket was made private', async () => {
    const world = passingWorld();
    world.buckets = [{ id: 'media', public: false }, PRIVATE_INVOICES];

    expect(await verdicts(world)).toEqual([true, true, false]);
  });

  it('keeps none of the keys it used in the probe', async () => {
    const { result } = await run(copyLeftWorld());

    for (const key of KEY_VALUES) {
      expect(JSON.stringify(result)).not.toContain(key);
    }
  });
});
