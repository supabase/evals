import { describe, expect, it } from 'vitest';
import { shellQuote } from '../lib/shell.js';
import {
  basename,
  bucketSeeding,
  createSandbox,
  type BucketConfig,
  passingProject,
  passingSeed,
  type Project,
  project,
  seedFiles,
  seedProbe,
  untouchedProject,
  untouchedSeed,
} from './fakes.js';
import {
  AVATARS,
  INVOICES,
  MEDIA_BUCKET,
  SEED_CONFIG_PATH,
  type SeedFile,
} from './fixtures.js';
import {
  checkFreshSetup,
  parseBucketDecls,
  readSeedConfig,
  type SeedConfigProbe,
} from './seed-config.js';

const FRESH = 'a fresh local setup keeps invoices private and avatars public';
const OTHER_SHA = 'f'.repeat(64);

const MEDIA_DECL = {
  name: 'media',
  public: true,
  objectsPath: './storage/media',
};

const byKey = (files: readonly SeedFile[]) =>
  [...files].sort((a, b) => a.key.localeCompare(b.key));

function seededBucket(probe: SeedConfigProbe, name: string) {
  if (!probe.ok) throw new Error(`seed probe unavailable: ${probe.notes}`);
  const bucket = probe.buckets.find((candidate) => candidate.name === name);
  if (bucket === undefined) throw new Error(`bucket ${name} not declared`);
  return bucket;
}

async function seed(current: Project) {
  const sandbox = createSandbox({ project: current });
  const result = await readSeedConfig(sandbox.ctx);
  return { ...sandbox, result };
}

describe('parseBucketDecls', () => {
  it('reads the public flag and objects_path of a declared bucket', () => {
    expect(
      parseBucketDecls(
        '[storage.buckets.media]\npublic = true\nobjects_path = "./storage/media"\n'
      )
    ).toEqual({ ok: true, storageEnabled: true, buckets: [MEDIA_DECL] });
  });

  it('defaults a bucket to private with no seed folder', () => {
    expect(parseBucketDecls('[storage.buckets.invoices]\n')).toEqual({
      ok: true,
      storageEnabled: true,
      buckets: [{ name: 'invoices', public: false }],
    });
  });

  it('keeps an explicit public = false', () => {
    expect(
      parseBucketDecls('[storage.buckets.invoices]\npublic = false\n')
    ).toMatchObject({ buckets: [{ name: 'invoices', public: false }] });
  });

  it('treats an empty objects_path as no seed folder', () => {
    expect(
      parseBucketDecls(
        '[storage.buckets.media]\npublic = true\nobjects_path = ""\n'
      )
    ).toEqual({
      ok: true,
      storageEnabled: true,
      buckets: [{ name: 'media', public: true }],
    });
  });

  it('ignores the other bucket settings', () => {
    expect(
      parseBucketDecls(
        [
          '[storage.buckets.media]',
          'public = true',
          'file_size_limit = "50MiB"',
          'allowed_mime_types = ["image/png", "image/svg+xml"]',
          'objects_path = "./storage/media"',
        ].join('\n')
      )
    ).toEqual({ ok: true, storageEnabled: true, buckets: [MEDIA_DECL] });
  });

  it('lists several buckets in the order they are declared', () => {
    const result = parseBucketDecls(
      [
        '[storage.buckets.media]',
        'public = true',
        '[storage.buckets.invoices]',
        'objects_path = "./storage/invoices"',
        '[storage.buckets.archive]',
        'public = false',
      ].join('\n')
    );

    expect(result).toEqual({
      ok: true,
      storageEnabled: true,
      buckets: [
        { name: 'media', public: true },
        { name: 'invoices', public: false, objectsPath: './storage/invoices' },
        { name: 'archive', public: false },
      ],
    });
  });

  it('enables storage when the config says nothing about it', () => {
    expect(parseBucketDecls('project_id = "ledgerly"\n')).toEqual({
      ok: true,
      storageEnabled: true,
      buckets: [],
    });
  });

  it('enables storage when the storage table has no enabled key', () => {
    expect(
      parseBucketDecls('[storage]\nfile_size_limit = "50MiB"\n')
    ).toMatchObject({ ok: true, storageEnabled: true });
  });

  it('reports storage disabled and still lists the declared buckets', () => {
    expect(
      parseBucketDecls(
        '[storage]\nenabled = false\n[storage.buckets.media]\npublic = true\n'
      )
    ).toEqual({
      ok: true,
      storageEnabled: false,
      buckets: [{ name: 'media', public: true }],
    });
  });

  it('parses an empty file as a config without buckets', () => {
    expect(parseBucketDecls('')).toEqual({
      ok: true,
      storageEnabled: true,
      buckets: [],
    });
  });

  it.each([
    [
      'a quoted bucket key',
      '[storage.buckets."media"]\npublic = true\nobjects_path = "./storage/media"\n',
    ],
    [
      'a literal-string path',
      "[storage.buckets.media]\npublic = true\nobjects_path = './storage/media'\n",
    ],
    [
      'comments, including a commented-out key',
      [
        '[storage.buckets.media] # the public one',
        'public = true # served by URL',
        '# objects_path = "./commented"',
        'objects_path = "./storage/media"',
      ].join('\n'),
    ],
    [
      'inline bucket tables',
      '[storage.buckets]\nmedia = { public = true, objects_path = "./storage/media" }\n',
    ],
    [
      'dotted keys under [storage]',
      '[storage]\nbuckets.media.public = true\nbuckets.media.objects_path = "./storage/media"\n',
    ],
    [
      'one inline storage table',
      'storage = { buckets = { media = { public = true, objects_path = "./storage/media" } } }\n',
    ],
    [
      'CRLF line endings',
      '[storage.buckets.media]\r\npublic = true\r\nobjects_path = "./storage/media"\r\n',
    ],
    [
      'the storage table defined after its bucket',
      '[storage.buckets.media]\npublic = true\nobjects_path = "./storage/media"\n\n[storage]\nenabled = true\n',
    ],
  ])('reads the media bucket from %s', (_name, toml) => {
    expect(parseBucketDecls(toml)).toEqual({
      ok: true,
      storageEnabled: true,
      buckets: [MEDIA_DECL],
    });
  });

  it('does not declare a bucket that is only commented out, nor read a commented-out public flag', () => {
    expect(
      parseBucketDecls(
        [
          '# [storage.buckets.ghost]',
          '[storage.buckets.media]',
          '# public = true',
          'objects_path = "./storage/media"',
        ].join('\n')
      )
    ).toEqual({
      ok: true,
      storageEnabled: true,
      buckets: [
        { name: 'media', public: false, objectsPath: './storage/media' },
      ],
    });
  });

  it.each([
    ['a dash', '[storage.buckets."customer-invoices"]\n', 'customer-invoices'],
    ['a dot', '[storage.buckets."a.b"]\n', 'a.b'],
    ['a space', "[storage.buckets.'my bucket']\n", 'my bucket'],
  ])('keeps a bucket name with %s as one name', (_name, toml, name) => {
    expect(parseBucketDecls(toml)).toMatchObject({
      ok: true,
      buckets: [{ name }],
    });
  });

  it('reads two inline buckets next to each other', () => {
    expect(
      parseBucketDecls(
        '[storage.buckets]\nmedia = { public = true }\ninvoices = { public = false, objects_path = "./storage/invoices" }\n'
      )
    ).toEqual({
      ok: true,
      storageEnabled: true,
      buckets: [
        { name: 'media', public: true },
        { name: 'invoices', public: false, objectsPath: './storage/invoices' },
      ],
    });
  });

  it.each([
    ['an unclosed table header', '[storage.buckets.media\npublic = true\n'],
    [
      'a redefined key',
      '[storage.buckets.media]\npublic = true\npublic = false\n',
    ],
    ['prose', 'this is not toml'],
  ])('fails with a note for %s', (_name, toml) => {
    const result = parseBucketDecls(toml);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ notes: expect.stringMatching(/\S/) });
  });
});

describe('readSeedConfig', () => {
  it('reads supabase/config.toml once and lists the files each seeded bucket would load', async () => {
    const { result, reads } = await seed(passingProject());

    expect(reads).toEqual([SEED_CONFIG_PATH]);
    expect(result).toMatchObject({ ok: true, storageEnabled: true });
    expect(seededBucket(result, 'media')).toMatchObject({
      name: 'media',
      public: true,
      objectsPath: './storage/media',
    });
    expect(byKey(seededBucket(result, 'media').files)).toEqual(byKey(AVATARS));
    expect(seededBucket(result, 'invoices')).toMatchObject({
      public: false,
      objectsPath: './storage/invoices',
    });
    expect(byKey(seededBucket(result, 'invoices').files)).toEqual(
      byKey(INVOICES.map(({ key, sha256 }) => ({ key: basename(key), sha256 })))
    );
  });

  it('lists every file under media with its path relative to the objects_path', async () => {
    const { result } = await seed(untouchedProject());

    expect(byKey(seededBucket(result, 'media').files)).toEqual(
      byKey([...AVATARS, ...INVOICES])
    );
  });

  it('runs one find and sha256sum per bucket that has an objects_path, naming the quoted path', async () => {
    const { commands, events } = await seed(passingProject());

    expect(events.filter((event) => event === 'find')).toHaveLength(2);
    const finds = commands.filter((command) => command.includes('find -L'));
    expect(finds).toHaveLength(2);
    for (const command of finds) expect(command).toContain('sha256sum');
    expect(finds.some((c) => c.includes(shellQuote('./storage/media')))).toBe(
      true
    );
    expect(
      finds.some((c) => c.includes(shellQuote('./storage/invoices')))
    ).toBe(true);
  });

  it('runs nothing for a bucket without an objects_path and lists no files for it', async () => {
    const { result, events } = await seed(
      project(
        [
          { name: 'media', public: true, objectsPath: './storage/media' },
          { name: 'scratch', public: false },
        ],
        seedFiles('storage/media', AVATARS)
      )
    );

    expect(events.filter((event) => event === 'find')).toHaveLength(1);
    expect(seededBucket(result, 'scratch').files).toEqual([]);
  });

  it('keeps spaces and nested folders in keys and drops only the leading ./', async () => {
    const { result } = await seed(
      project(
        [{ name: 'docs', public: false, objectsPath: './storage/docs' }],
        { 'storage/docs/2026 Q1/INV 1.pdf': INVOICES[0].sha256 }
      )
    );

    expect(seededBucket(result, 'docs').files).toEqual([
      { key: '2026 Q1/INV 1.pdf', sha256: INVOICES[0].sha256 },
    ]);
  });

  it('shell-quotes an objects_path that holds a space and a quote', async () => {
    const objectsPath = "./storage/it's here";
    const { result, commands } = await seed(
      project([{ name: 'docs', public: false, objectsPath }], {
        "storage/it's here/a.pdf": INVOICES[0].sha256,
      })
    );

    expect(commands.some((c) => c.includes(shellQuote(objectsPath)))).toBe(
      true
    );
    expect(seededBucket(result, 'docs').files).toEqual([
      { key: 'a.pdf', sha256: INVOICES[0].sha256 },
    ]);
  });

  it('does not count a .DS_Store file as a seed file', async () => {
    const { result } = await seed(
      project(
        [{ name: 'media', public: true, objectsPath: './storage/media' }],
        {
          ...seedFiles('storage/media', AVATARS),
          'storage/media/.DS_Store': OTHER_SHA,
        }
      )
    );

    expect(byKey(seededBucket(result, 'media').files)).toEqual(byKey(AVATARS));
  });

  it('lists no files and no note for an existing empty folder', async () => {
    const { result } = await seed(
      project(
        [
          {
            name: 'invoices',
            public: false,
            objectsPath: './storage/invoices',
          },
        ],
        {},
        { dirs: ['storage/invoices'] }
      )
    );

    const bucket = seededBucket(result, 'invoices');
    expect(bucket.files).toEqual([]);
    expect(bucket.notes).toBeUndefined();
  });

  it('lists no files and says why for an objects_path whose folder is missing, keeping the other buckets', async () => {
    const { result } = await seed(
      project(
        [
          { name: 'media', public: true, objectsPath: './storage/media' },
          { name: 'ghost', public: false, objectsPath: './storage/ghost' },
        ],
        seedFiles('storage/media', AVATARS)
      )
    );

    expect(result.ok).toBe(true);
    const ghost = seededBucket(result, 'ghost');
    expect(ghost.files).toEqual([]);
    expect(ghost.notes).toMatch(/\S/);
    expect(byKey(seededBucket(result, 'media').files)).toEqual(byKey(AVATARS));
  });

  it('reports storage disabled in the config', async () => {
    const { result } = await seed(
      project(
        [{ name: 'media', public: true, objectsPath: './storage/media' }],
        seedFiles('storage/media', AVATARS),
        { storageEnabled: false }
      )
    );

    expect(result).toMatchObject({ ok: true, storageEnabled: false });
  });

  it('fails with the reason and lists nothing when the config cannot be read', async () => {
    const { result, events } = await seed({
      ...passingProject(),
      config: new Error('ENOENT: no such file or directory, open config.toml'),
    });

    expect(result).toEqual({
      ok: false,
      notes: expect.stringContaining('ENOENT'),
    });
    expect(events).not.toContain('find');
  });

  it('fails with a note and lists nothing when the config is not valid TOML', async () => {
    const { result, events } = await seed({
      ...passingProject(),
      config: '[storage.buckets.media\npublic = true\n',
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ notes: expect.stringMatching(/\S/) });
    expect(events).not.toContain('find');
  });
});

describe('checkFreshSetup', () => {
  it('passes for an avatars-only public media bucket and a private invoices bucket', () => {
    expect(checkFreshSetup(passingSeed())).toMatchObject({
      name: FRESH,
      passed: true,
    });
  });

  it.each<[string, SeedConfigProbe]>([
    [
      'any private bucket name and folder',
      seedProbe(
        bucketSeeding(MEDIA_BUCKET, true, AVATARS),
        bucketSeeding('customer-invoices', false, INVOICES, './private/docs')
      ),
    ],
    [
      'invoices split over two private buckets',
      seedProbe(
        bucketSeeding(MEDIA_BUCKET, true, AVATARS),
        bucketSeeding('q1', false, [INVOICES[0]]),
        bucketSeeding('q2', false, [INVOICES[1], INVOICES[2]])
      ),
    ],
    [
      'a private bucket that also seeds the avatars',
      seedProbe(
        bucketSeeding(MEDIA_BUCKET, true, AVATARS),
        bucketSeeding('backup', false, [...AVATARS, ...INVOICES])
      ),
    ],
    [
      'other non-invoice files in the public bucket',
      seedProbe(
        bucketSeeding(MEDIA_BUCKET, true, [
          ...AVATARS,
          { key: 'docs/readme.txt', sha256: OTHER_SHA },
        ]),
        bucketSeeding('invoices', false, INVOICES)
      ),
    ],
    [
      'a declared private bucket with an empty folder',
      seedProbe(
        bucketSeeding(MEDIA_BUCKET, true, AVATARS),
        bucketSeeding('invoices', false, [])
      ),
    ],
  ])('passes with %s', (_name, probe) => {
    expect(checkFreshSetup(probe).passed).toBe(true);
  });

  it('passes when the invoice seed files were deleted and says invoices are no longer seeded', () => {
    const check = checkFreshSetup(
      seedProbe(bucketSeeding(MEDIA_BUCKET, true, AVATARS))
    );

    expect(check.passed).toBe(true);
    expect(check.notes).toMatch(/invoice/i);
  });

  it('passes when a public bucket besides media has a missing folder', () => {
    expect(
      checkFreshSetup(
        seedProbe(bucketSeeding(MEDIA_BUCKET, true, AVATARS), {
          ...bucketSeeding('extras', true, [], './storage/extras'),
          notes: 'cd: no such file or directory',
        })
      ).passed
    ).toBe(true);
  });

  it('fails when the config still seeds the invoices into the public bucket', () => {
    const check = checkFreshSetup(untouchedSeed());

    expect(check).toMatchObject({ name: FRESH, passed: false });
    expect(check.notes).toContain('media');
  });

  it('fails when the invoices only moved to a subfolder of the public bucket folder', () => {
    expect(
      checkFreshSetup(
        seedProbe(
          bucketSeeding(MEDIA_BUCKET, true, [
            ...AVATARS,
            ...INVOICES.map(({ key, sha256 }) => ({
              key: `private/${key}`,
              sha256,
            })),
          ])
        )
      ).passed
    ).toBe(false);
  });

  it('fails when an invoice is renamed inside a public bucket because its bytes are the same', () => {
    expect(
      checkFreshSetup(
        seedProbe(
          bucketSeeding(MEDIA_BUCKET, true, [
            ...AVATARS,
            { key: 'receipts/q1.bin', sha256: INVOICES[0].sha256 },
          ]),
          bucketSeeding('invoices', false, INVOICES)
        )
      ).passed
    ).toBe(false);
  });

  it('fails when a second public bucket seeds an invoice even though media is clean, naming it', () => {
    const check = checkFreshSetup(
      seedProbe(
        bucketSeeding(MEDIA_BUCKET, true, AVATARS),
        bucketSeeding('public-docs', true, [INVOICES[1]])
      )
    );

    expect(check.passed).toBe(false);
    expect(check.notes).toContain('public-docs');
  });

  it('fails when media is declared private', () => {
    expect(
      checkFreshSetup(
        seedProbe(
          bucketSeeding(MEDIA_BUCKET, false, AVATARS),
          bucketSeeding('invoices', false, INVOICES)
        )
      ).passed
    ).toBe(false);
  });

  it('fails when the media folder was narrowed so the avatar keys lose their avatars/ prefix', () => {
    expect(
      checkFreshSetup(
        seedProbe(
          bucketSeeding(
            MEDIA_BUCKET,
            true,
            AVATARS.map(({ key, sha256 }) => ({ key: basename(key), sha256 })),
            './storage/media/avatars'
          ),
          bucketSeeding('invoices', false, INVOICES)
        )
      ).passed
    ).toBe(false);
  });

  it('fails when media seeds an avatar with other bytes', () => {
    expect(
      checkFreshSetup(
        seedProbe(
          bucketSeeding(MEDIA_BUCKET, true, [
            { key: AVATARS[0].key, sha256: OTHER_SHA },
            AVATARS[1],
            AVATARS[2],
          ]),
          bucketSeeding('invoices', false, INVOICES)
        )
      ).passed
    ).toBe(false);
  });

  it('fails when media no longer seeds one avatar and names it', () => {
    const check = checkFreshSetup(
      seedProbe(
        bucketSeeding(MEDIA_BUCKET, true, [AVATARS[0], AVATARS[1]]),
        bucketSeeding('invoices', false, INVOICES)
      )
    );

    expect(check.passed).toBe(false);
    expect(check.notes).toContain(AVATARS[2].key);
  });

  it('fails when the avatars are seeded into a public bucket other than media', () => {
    expect(
      checkFreshSetup(
        seedProbe(
          bucketSeeding('assets', true, AVATARS),
          bucketSeeding('invoices', false, INVOICES)
        )
      ).passed
    ).toBe(false);
  });

  it('fails when media is not declared at all', () => {
    expect(
      checkFreshSetup(seedProbe(bucketSeeding('invoices', false, INVOICES)))
        .passed
    ).toBe(false);
  });

  it('fails when media declares no objects_path and so seeds nothing', () => {
    expect(
      checkFreshSetup(
        seedProbe({
          name: MEDIA_BUCKET,
          public: true,
          files: [],
        })
      ).passed
    ).toBe(false);
  });

  it('fails when storage is disabled, since nothing would be seeded', () => {
    expect(
      checkFreshSetup({ ...passingSeed(), storageEnabled: false }).passed
    ).toBe(false);
  });

  it('fails with the probe notes when the config could not be read', () => {
    const check = checkFreshSetup({
      ok: false,
      notes: 'ENOENT: no such file or directory',
    });

    expect(check).toMatchObject({ name: FRESH, passed: false });
    expect(check.notes).toContain('ENOENT');
  });
});

describe('the fresh-setup check on a project read from the sandbox', () => {
  const verdict = async (current: Project) => {
    const { result } = await seed(current);
    return checkFreshSetup(result).passed;
  };

  const withMedia = (
    mediaConfig: BucketConfig,
    files: Record<string, string>
  ) => project([mediaConfig], files);

  it('passes once the invoices have a private bucket and folder of their own', async () => {
    expect(await verdict(passingProject())).toBe(true);
  });

  it('fails for the project as it was seeded', async () => {
    expect(await verdict(untouchedProject())).toBe(false);
  });

  it('fails when the invoices were moved into a subfolder under the media folder', async () => {
    expect(
      await verdict(
        withMedia(
          { name: 'media', public: true, objectsPath: './storage/media' },
          {
            ...seedFiles('storage/media', AVATARS),
            ...seedFiles('storage/media/private', INVOICES),
          }
        )
      )
    ).toBe(false);
  });

  it('fails when an invoice was renamed inside the media folder', async () => {
    expect(
      await verdict(
        withMedia(
          { name: 'media', public: true, objectsPath: './storage/media' },
          {
            ...seedFiles('storage/media', AVATARS),
            'storage/media/receipts/q1.bin': INVOICES[0].sha256,
          }
        )
      )
    ).toBe(false);
  });

  it('fails when media points at the avatars folder, so the keys lose avatars/', async () => {
    expect(
      await verdict(
        project(
          [
            {
              name: 'media',
              public: true,
              objectsPath: './storage/media/avatars',
            },
            {
              name: 'invoices',
              public: false,
              objectsPath: './storage/invoices',
            },
          ],
          {
            ...seedFiles('storage/media', AVATARS),
            ...seedFiles('storage/invoices', INVOICES, (f) => basename(f.key)),
          }
        )
      )
    ).toBe(false);
  });

  it('fails when media was made private', async () => {
    expect(
      await verdict(
        project(
          [
            { name: 'media', public: false, objectsPath: './storage/media' },
            {
              name: 'invoices',
              public: false,
              objectsPath: './storage/invoices',
            },
          ],
          {
            ...seedFiles('storage/media', AVATARS),
            ...seedFiles('storage/invoices', INVOICES),
          }
        )
      )
    ).toBe(false);
  });

  it.each(['storage/media', './storage/media/', './storage/../storage/media'])(
    'passes when media spells its folder %s',
    async (objectsPath) => {
      expect(
        await verdict(
          project(
            [
              { name: 'media', public: true, objectsPath },
              {
                name: 'invoices',
                public: false,
                objectsPath: './storage/invoices',
              },
            ],
            {
              ...seedFiles('storage/media', AVATARS),
              ...seedFiles('storage/invoices', INVOICES),
            }
          )
        )
      ).toBe(true);
    }
  );

  it('passes when the invoice seed files were deleted and the folder is gone', async () => {
    expect(
      await verdict(
        project(
          [
            { name: 'media', public: true, objectsPath: './storage/media' },
            {
              name: 'invoices',
              public: false,
              objectsPath: './storage/invoices',
            },
          ],
          seedFiles('storage/media', AVATARS)
        )
      )
    ).toBe(true);
  });

  it('passes for a private bucket under a quoted name', async () => {
    expect(
      await verdict(
        project(
          [
            { name: 'media', public: true, objectsPath: './storage/media' },
            {
              name: 'customer invoices',
              public: false,
              objectsPath: './storage/invoices',
            },
          ],
          {
            ...seedFiles('storage/media', AVATARS),
            ...seedFiles('storage/invoices', INVOICES),
          }
        )
      )
    ).toBe(true);
  });

  it('passes for a config written with inline tables and comments', async () => {
    const config = [
      '# seeded buckets',
      'project_id = "ledgerly"',
      '[storage.buckets]',
      'media = { public = true, objects_path = "./storage/media" } # avatars',
      'invoices = { public = false, objects_path = "./storage/invoices" }',
    ].join('\n');

    expect(
      await verdict({
        config,
        objectsPaths: ['./storage/media', './storage/invoices'],
        files: {
          ...seedFiles('storage/media', AVATARS),
          ...seedFiles('storage/invoices', INVOICES),
        },
      })
    ).toBe(true);
  });
});
