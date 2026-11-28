import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ARTICLE_URL, readSeedFile } from './fixtures.js';

describe('resolve-cli-006 fixtures', () => {
  it('turns standard_conforming_strings off for the database in a migration', () => {
    expect(
      readSeedFile(
        'supabase/migrations/20260106000000_legacy_string_settings.sql'
      )
    ).toMatch(/alter database postgres set standard_conforming_strings = off;/);
  });

  it('registers a path with an octal zero escape in a plain string literal', () => {
    const script = readSeedFile('scripts/register-asset.sql');
    expect(script).toContain(String.raw`'C:\0ps\raw\scan-002.tif'`);
    expect(script).not.toMatch(/E'/);
  });

  it('seeds the first scan with E-string backslashes', () => {
    expect(readSeedFile('supabase/seed.sql')).toContain(
      String.raw`E'C:\\ops\\raw\\scan-001.tif'`
    );
  });

  it('links an article under /kb/troubleshooting', () => {
    expect(ARTICLE_URL).toMatch(
      /^https:\/\/supabase\.com\/kb\/troubleshooting\//
    );
  });

  it('never names the error, the article or the fix in the prompt', () => {
    const prompt = readFileSync(
      new URL('./PROMPT.md', import.meta.url),
      'utf8'
    );
    const body = prompt.split(/^---$/m).slice(2).join('');
    expect(body).not.toMatch(
      /22021|SQLSTATE|byte|UTF8|0x00|standard_conforming|escape|alter database|kb\/troubleshooting|supabase\.com/i
    );
  });
});
