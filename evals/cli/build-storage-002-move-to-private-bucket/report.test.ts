import { describe, expect, it } from 'vitest';
import { mentionsNumber } from '../lib/report.js';
import {
  bucketSeeding,
  fetched,
  invoiceHeld,
  KEY_VALUES,
  MEDIA,
  mediaAvatars,
  mediaInvoiceHeld,
  movedInvoices,
  passingSeed,
  seedProbe,
  served,
  STACK,
  storageProbe,
  untouchedSeed,
} from './fakes.js';
import { AVATARS, INVOICES, MEDIA_BUCKET } from './fixtures.js';
import { describeGroundTruth } from './report.js';

type Facts = Parameters<typeof describeGroundTruth>[0];

const FACTS: Facts = {
  stack: STACK,
  storage: storageProbe(),
  seed: passingSeed(),
  storageCommands: [],
};

const groundTruth = (overrides: Partial<Facts> = {}) =>
  describeGroundTruth({ ...FACTS, ...overrides });

const OTHER_SHA = 'f'.repeat(64);
const MISMATCH =
  /differ|mismatch|not match|no match|don't match|doesn't match|wrong/i;

function blockFor(lines: string[], needle: string | RegExp): string {
  const taken = new Set<number>();
  lines.forEach((line, start) => {
    const hit =
      typeof needle === 'string' ? line.includes(needle) : needle.test(line);
    if (!hit) return;
    taken.add(start);
    for (
      let i = start + 1;
      i < lines.length && lines[i].startsWith('  ');
      i++
    ) {
      taken.add(i);
    }
  });
  return [...taken]
    .sort((a, b) => a - b)
    .map((index) => lines[index])
    .join('\n');
}

const count = (text: string, pattern: RegExp) =>
  text.match(new RegExp(pattern, 'g'))?.length ?? 0;

const COPY_LEFT = () =>
  storageProbe({
    objects: [
      ...mediaAvatars(),
      ...INVOICES.map((file) =>
        mediaInvoiceHeld(file, {
          public: served(file.sha256),
          anon: fetched(403),
        })
      ),
      ...movedInvoices(),
    ],
    originalInvoices: Object.fromEntries(
      INVOICES.map(({ key, sha256 }) => [key, served(sha256)])
    ),
  });

describe('describeGroundTruth', () => {
  it('writes every fact as a dash-led line, with continuations indented', () => {
    const lines = [
      ...groundTruth(),
      ...groundTruth({ storage: COPY_LEFT(), seed: untouchedSeed() }),
      ...groundTruth({
        stack: { ok: false, notes: 'The local stack is not running.' },
        storage: { ok: false, notes: 'The local stack is not running.' },
        seed: { ok: false, notes: 'ENOENT: supabase/config.toml' },
        storageCommands: ['supabase storage ls ss:///media --local'],
      }),
    ];

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.startsWith('- ') || line.startsWith('  ')).toBe(true);
    }
  });

  describe('stack', () => {
    it('describes a resolved stack with its backend and runtime', () => {
      expect(groundTruth().join('\n')).toContain('resolved: legacy/docker');
    });

    it('names the relocated CLI home of a stack found under one', () => {
      expect(
        groundTruth({
          stack: { ...STACK, relocatedHome: '/home/agent/.supabase' },
        }).join('\n')
      ).toContain('/home/agent/.supabase');
    });

    it('carries the notes of an unresolved stack', () => {
      expect(
        groundTruth({
          stack: { ok: false, notes: 'The local stack is not running.' },
        }).join('\n')
      ).toContain('none (The local stack is not running.)');
    });

    it('never carries the database credentials', () => {
      expect(
        groundTruth({
          stack: {
            ...STACK,
            dbUrl: 'postgresql://postgres:hunter2@127.0.0.1:54322/postgres',
          },
        }).join('\n')
      ).not.toContain('hunter2');
    });
  });

  describe('storage probe', () => {
    it('says the probe is unavailable and why, without claiming the invoices are missing', () => {
      const text = groundTruth({
        storage: { ok: false, notes: 'The local stack is not running.' },
      }).join('\n');

      expect(text).toMatch(/unavailable/i);
      expect(text).toContain('The local stack is not running.');
      expect(text).not.toContain('not found on the stack');
    });

    it('gives the status of the storage API control request with the service key', () => {
      const line = blockFor(groundTruth(), /control request with the service/i);

      expect(mentionsNumber(line, 200)).toBe(true);
    });

    it('gives a failing control status instead of 200', () => {
      const line = blockFor(
        groundTruth({ storage: storageProbe({ control: fetched(401) }) }),
        /control request with the service/i
      );

      expect(mentionsNumber(line, 401)).toBe(true);
      expect(mentionsNumber(line, 200)).toBe(false);
    });

    it('gives the status of the storage API control request with the anon key', () => {
      const line = blockFor(groundTruth(), /control request with the anon/i);

      expect(mentionsNumber(line, 200)).toBe(true);
    });

    it('gives a rejected anon key as its control status and the service key as unaffected', () => {
      const lines = groundTruth({
        storage: storageProbe({ anonControl: fetched(401) }),
      });

      const anon = blockFor(lines, /control request with the anon/i);
      expect(mentionsNumber(anon, 401)).toBe(true);
      expect(mentionsNumber(anon, 200)).toBe(false);
      expect(
        mentionsNumber(
          blockFor(lines, /control request with the service/i),
          200
        )
      ).toBe(true);
    });

    it('says why no anon control request was made when the stack printed no anon key', () => {
      const line = blockFor(
        groundTruth({
          storage: storageProbe({
            anonControl: {
              status: null,
              sha256: null,
              notes: 'no anon key could be read from the stack status',
            },
          }),
        }),
        /control request with the anon/i
      );

      expect(line).toContain('no anon key could be read');
    });

    it('lists each bucket with whether it is public or private', () => {
      const text = groundTruth({
        storage: storageProbe({
          buckets: [
            MEDIA,
            { id: 'customer-docs', public: false },
            { id: 'press-kit', public: true },
          ],
          objects: mediaAvatars(),
        }),
        seed: seedProbe(bucketSeeding(MEDIA_BUCKET, true, AVATARS)),
      }).join('\n');

      expect(text).toContain('customer-docs (private)');
      expect(text).toContain('press-kit (public)');
    });
  });

  describe('where each invoice is', () => {
    it('says each moved invoice sits in a private bucket and never in a public one', () => {
      const text = groundTruth().join('\n');

      for (const invoice of INVOICES) {
        const name = invoice.key.slice(invoice.key.lastIndexOf('/') + 1);
        expect(text).toContain(`invoices/${name} (private)`);
        expect(text).not.toMatch(new RegExp(`${name} \\(public\\)`));
      }
      expect(text).not.toContain('not found on the stack');
    });

    it('lists both copies of an invoice that was copied and not moved', () => {
      const text = groundTruth({ storage: COPY_LEFT() }).join('\n');

      for (const invoice of INVOICES) {
        const name = invoice.key.slice(invoice.key.lastIndexOf('/') + 1);
        expect(text).toContain(`media/invoices/${name} (public)`);
        expect(text).toContain(`invoices/${name} (private)`);
      }
    });

    it('says an invoice is not found on the stack once it is gone', () => {
      const text = groundTruth({
        storage: storageProbe({ objects: mediaAvatars() }),
      }).join('\n');

      expect(count(text, /not found on the stack/)).toBe(INVOICES.length);
      expect(text).not.toMatch(/INV-2026-014\d\.pdf \((public|private)\)/);
    });

    it('says an invoice whose bytes cannot be downloaded is not found rather than moved', () => {
      const [first, ...rest] = movedInvoices();
      const text = groundTruth({
        storage: storageProbe({
          objects: [
            ...mediaAvatars(),
            { ...first, service: fetched(400) },
            ...rest,
          ],
        }),
      }).join('\n');

      expect(count(text, /not found on the stack/)).toBe(1);
      expect(text).not.toContain('invoices/INV-2026-0141.pdf (private)');
      expect(text).toContain('invoices/INV-2026-0142.pdf (private)');
    });

    it('gives the anon read status of an invoice in a private bucket', () => {
      const lines = groundTruth({
        storage: storageProbe({
          objects: [
            ...mediaAvatars(),
            ...INVOICES.map((file) =>
              invoiceHeld(file, { anon: fetched(401) })
            ),
          ],
        }),
      });

      for (const invoice of INVOICES) {
        const name = invoice.key.slice(invoice.key.lastIndexOf('/') + 1);
        expect(mentionsNumber(blockFor(lines, name), 401)).toBe(true);
      }
    });

    it('gives the public-URL and anon read statuses of an invoice copy in a public bucket', () => {
      const lines = groundTruth({
        storage: storageProbe({
          objects: [
            ...mediaAvatars(),
            ...INVOICES.map((file) =>
              mediaInvoiceHeld(file, {
                public: served(file.sha256),
                anon: fetched(401),
              })
            ),
            ...movedInvoices(),
          ],
        }),
      });

      for (const invoice of INVOICES) {
        const block = blockFor(lines, `media/${invoice.key}`);
        expect(mentionsNumber(block, 200)).toBe(true);
        expect(mentionsNumber(block, 401)).toBe(true);
      }
    });
  });

  describe('original media/invoices keys', () => {
    it('gives the public-URL read status of each original key', () => {
      const lines = groundTruth({
        storage: storageProbe({
          originalInvoices: {
            [INVOICES[0].key]: fetched(404),
            [INVOICES[1].key]: served(INVOICES[1].sha256),
            [INVOICES[2].key]: fetched(400),
          },
        }),
      });

      const first = blockFor(lines, `media/${INVOICES[0].key}`);
      const second = blockFor(lines, `media/${INVOICES[1].key}`);
      const third = blockFor(lines, `media/${INVOICES[2].key}`);
      expect(mentionsNumber(first, 404)).toBe(true);
      expect(mentionsNumber(first, 200)).toBe(false);
      expect(mentionsNumber(second, 200)).toBe(true);
      expect(mentionsNumber(third, 400)).toBe(true);
      expect(mentionsNumber(third, 200)).toBe(false);
    });
  });

  describe('avatars', () => {
    it('gives each avatar public-URL status and says its bytes match', () => {
      const lines = groundTruth();

      for (const avatar of AVATARS) {
        const block = blockFor(lines, avatar.key);
        expect(mentionsNumber(block, 200)).toBe(true);
        expect(block).toMatch(/match/i);
        expect(block).not.toMatch(MISMATCH);
      }
    });

    it('says an avatar served with other bytes does not match', () => {
      const lines = groundTruth({
        storage: storageProbe({
          avatars: {
            ...storageProbe().avatars,
            [AVATARS[0].key]: served(OTHER_SHA),
          },
        }),
      });

      expect(blockFor(lines, AVATARS[0].key)).toMatch(MISMATCH);
      expect(blockFor(lines, AVATARS[1].key)).not.toMatch(MISMATCH);
    });

    it('gives the failing status of an avatar that is not publicly readable', () => {
      const lines = groundTruth({
        storage: storageProbe({
          avatars: {
            ...storageProbe().avatars,
            [AVATARS[1].key]: fetched(404),
          },
        }),
      });

      const block = blockFor(lines, AVATARS[1].key);
      expect(mentionsNumber(block, 404)).toBe(true);
      expect(mentionsNumber(block, 200)).toBe(false);
    });
  });

  describe('fresh setup', () => {
    it('describes each declared bucket with its flag, folder and seeded avatar and invoice counts', () => {
      const text = groundTruth().join('\n');

      expect(text).toContain(
        'media (public), objects_path ./storage/media: 3 avatar files, 0 invoice files'
      );
      expect(text).toContain(
        'invoices (private), objects_path ./storage/invoices: 0 avatar files, 3 invoice files'
      );
    });

    it('shows invoices still seeded into the public bucket', () => {
      expect(groundTruth({ seed: untouchedSeed() }).join('\n')).toContain(
        'media (public), objects_path ./storage/media: 3 avatar files, 3 invoice files'
      );
    });

    it('counts a renamed invoice by its bytes', () => {
      const text = groundTruth({
        seed: seedProbe(
          bucketSeeding('docs', true, [
            { key: 'a.bin', sha256: INVOICES[0].sha256 },
            { key: 'b.bin', sha256: INVOICES[1].sha256 },
            { key: 'c.bin', sha256: OTHER_SHA },
          ])
        ),
      }).join('\n');

      expect(text).toMatch(
        /docs \(public\), objects_path .*: 0 avatar files, 2 invoice files/
      );
    });

    it('lists a declared bucket that seeds no folder without failing', () => {
      const text = groundTruth({
        seed: seedProbe({ name: 'archive', public: false, files: [] }),
      }).join('\n');

      expect(text).toContain('archive (private)');
    });

    it('says a missing folder seeds nothing and that a listing failure was not read', () => {
      const text = groundTruth({
        seed: seedProbe(
          {
            ...bucketSeeding('gone', false, [], './storage/gone'),
            notes: './storage/gone does not exist, so it seeds nothing',
          },
          {
            ...bucketSeeding('locked', true, [], './storage/locked'),
            error: 'exit 1: Permission denied',
          }
        ),
      }).join('\n');

      expect(text).toContain(
        'gone (private), objects_path ./storage/gone: 0 avatar files, 0 invoice files [./storage/gone does not exist, so it seeds nothing]'
      );
      expect(text).toContain(
        'locked (public), objects_path ./storage/locked: 0 avatar files, 0 invoice files [could not list it: exit 1: Permission denied]'
      );
    });

    it('carries the reason when the config could not be read', () => {
      const text = groundTruth({
        seed: { ok: false, notes: 'ENOENT: supabase/config.toml' },
      }).join('\n');

      expect(text).toContain('ENOENT: supabase/config.toml');
    });
  });

  describe('storage commands', () => {
    it('reports zero when the agent ran none', () => {
      expect(
        mentionsNumber(blockFor(groundTruth(), /storage commands/i), 0)
      ).toBe(true);
    });

    it('gives the count and each command when there are few', () => {
      const commands = [
        'supabase storage ls ss:///alpha --local',
        'supabase storage cp ./a ss:///bravo --local',
        'supabase seed buckets',
      ];

      const block = blockFor(
        groundTruth({ storageCommands: commands }),
        /storage commands/i
      );

      expect(mentionsNumber(block, 3)).toBe(true);
      for (const command of commands) expect(block).toContain(command);
    });

    it('gives the full count but only the last eight commands', () => {
      const commands = 'abcdefghijkl'
        .split('')
        .map((letter) => `supabase storage ls ss:///bucket-${letter} --local`);

      const block = blockFor(
        groundTruth({ storageCommands: commands }),
        /storage commands/i
      );

      expect(mentionsNumber(block, 12)).toBe(true);
      for (const letter of 'efghijkl') {
        expect(block).toContain(`bucket-${letter} `);
      }
      for (const letter of 'abcd') {
        expect(block).not.toContain(`bucket-${letter} `);
      }
    });

    it('keeps a very long command out of the ground truth', () => {
      const text = groundTruth({
        storageCommands: [
          `supabase storage cp ./${'x'.repeat(20_000)} ss:///a`,
        ],
      }).join('\n');

      expect(text.length).toBeLessThan(4_000);
    });
  });

  describe('credentials', () => {
    it('never carries an API key, even from a command that holds one', () => {
      const text = groundTruth({
        storage: COPY_LEFT(),
        storageCommands: KEY_VALUES.map(
          (key) => `supabase storage ls ss:///media --apikey ${key} --local`
        ),
      }).join('\n');

      for (const key of KEY_VALUES) expect(text).not.toContain(key);
    });
  });

  it('describes a run with nothing resolved without throwing and keeps every reason', () => {
    const text = groundTruth({
      stack: { ok: false, notes: 'stack down' },
      storage: { ok: false, notes: 'storage down' },
      seed: { ok: false, notes: 'config down' },
    }).join('\n');

    expect(text).toContain('stack down');
    expect(text).toContain('storage down');
    expect(text).toContain('config down');
  });
});
