import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import {
  AVATARS,
  INVOICES,
  invoiceFor,
  MEDIA_BUCKET,
  SEED_CONFIG_PATH,
} from './fixtures.js';

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCAL = path.join(EVAL_DIR, 'local');
const MEDIA_DIR = path.join(LOCAL, 'supabase', 'storage', 'media');
const SEED_FILES = [...AVATARS, ...INVOICES];

const sha256 = (bytes: Buffer) =>
  crypto.createHash('sha256').update(bytes).digest('hex');

const readSeed = (key: string) => fs.readFileSync(path.join(MEDIA_DIR, key));

function listFiles(dir: string, prefix = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      return listFiles(path.join(dir, entry.name), relative);
    }
    return entry.name === '.DS_Store' ? [] : [relative];
  });
}

function xrefProblems(pdf: Buffer): string[] {
  const text = pdf.toString('latin1');
  const trailer = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text);
  if (trailer === null) return ['no startxref and %%EOF at the end'];
  const at = Number(trailer[1]);
  if (!text.startsWith('xref', at)) {
    return [`startxref ${at} does not point at the xref table`];
  }
  const table = /^xref\s+0\s+(\d+)\s+([\s\S]*?)trailer/.exec(text.slice(at));
  if (table === null) return ['xref table does not start at object 0'];
  const entries = [...table[2].matchAll(/(\d{10}) (\d{5}) ([nf])/g)];
  const problems: string[] = [];
  if (entries.length !== Number(table[1])) {
    problems.push(
      `xref declares ${table[1]} entries but lists ${entries.length}`
    );
  }
  entries.forEach(([, offset, , type], objectNumber) => {
    if (
      type === 'n' &&
      !text.startsWith(`${objectNumber} 0 obj`, Number(offset))
    ) {
      problems.push(
        `object ${objectNumber} is not at offset ${Number(offset)}`
      );
    }
  });
  return problems;
}

type SeedConfig = {
  storage?: {
    enabled?: boolean;
    buckets?: Record<string, { public?: boolean; objects_path?: string }>;
  };
};

const seedConfig = () =>
  parse(
    fs.readFileSync(path.join(LOCAL, 'supabase', 'config.toml'), 'utf8')
  ) as SeedConfig;

describe('seed constants', () => {
  it('names the media bucket and the config path the scorer reads', () => {
    expect(MEDIA_BUCKET).toBe('media');
    expect(SEED_CONFIG_PATH).toBe('supabase/config.toml');
  });

  it('keys the avatars and invoices the way the app and the config lay them out', () => {
    expect(AVATARS.map(({ key }) => key)).toEqual([
      'avatars/ava.svg',
      'avatars/ben.svg',
      'avatars/cleo.svg',
    ]);
    expect(INVOICES.map(({ key }) => key)).toEqual([
      'invoices/INV-2026-0141.pdf',
      'invoices/INV-2026-0142.pdf',
      'invoices/INV-2026-0143.pdf',
    ]);
  });

  it('gives every file a lower-case sha256 hex digest', () => {
    for (const { sha256: digest } of SEED_FILES) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('gives all six files a distinct hash', () => {
    expect(new Set(SEED_FILES.map((file) => file.sha256)).size).toBe(6);
  });
});

describe('the seeded media folder', () => {
  it.each(SEED_FILES)('hashes $key to the recorded sha256', (file) => {
    expect(sha256(readSeed(file.key))).toBe(file.sha256);
  });

  it('holds exactly the avatar and invoice files', () => {
    expect(listFiles(MEDIA_DIR).sort()).toEqual(
      SEED_FILES.map(({ key }) => key).sort()
    );
  });

  it.each(INVOICES)('stores $key as an ASCII-only PDF', ({ key }) => {
    const bytes = readSeed(key);

    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.every((byte) => byte < 0x80)).toBe(true);
  });

  it.each(INVOICES)('stores $key with correct xref offsets', ({ key }) => {
    expect(xrefProblems(readSeed(key))).toEqual([]);
  });

  it.each(AVATARS)('stores $key as an SVG', ({ key }) => {
    expect(readSeed(key).toString('utf8')).toContain('<svg');
  });
});

describe('the seeded supabase config', () => {
  it('declares the media bucket as public and seeds it from storage/media', () => {
    expect(seedConfig().storage?.buckets?.media).toMatchObject({
      public: true,
      objects_path: './storage/media',
    });
  });

  it('declares no bucket besides media', () => {
    expect(Object.keys(seedConfig().storage?.buckets ?? {})).toEqual(['media']);
  });
});

describe('the seeded app code', () => {
  it('loads avatars from the media bucket by their avatars/ path', () => {
    const source = fs.readFileSync(
      path.join(LOCAL, 'src', 'lib', 'avatars.ts'),
      'utf8'
    );

    expect(source).toContain("'media'");
    expect(source).toContain('avatars/');
  });
});

describe('invoiceFor', () => {
  it.each(INVOICES)('returns $key for its own hash', (invoice) => {
    expect(invoiceFor(invoice.sha256)).toEqual(invoice);
  });

  it.each(AVATARS)(
    'returns nothing for the hash of $key',
    ({ sha256: hash }) => {
      expect(invoiceFor(hash)).toBeUndefined();
    }
  );

  it('returns nothing for a hash no seed file has', () => {
    expect(invoiceFor('0'.repeat(64))).toBeUndefined();
  });

  it.each([null, undefined, ''])('returns nothing for %j', (hash) => {
    expect(invoiceFor(hash)).toBeUndefined();
  });
});
