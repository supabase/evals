import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ARTICLE_URL, readSeedFile, SEEDED_PROFILES } from './fixtures.js';

describe('resolve-cli-005 fixtures', () => {
  it('seeds each member with an id, a name and an email', () => {
    const seed = readSeedFile('supabase/seed.sql');
    for (const row of SEEDED_PROFILES) {
      const [id, name, email] = row.split('|');
      expect(seed).toContain(`(${id}, '${name}', '${email}'`);
    }
  });

  it('grants the page role column-level select without the email', () => {
    const migration = readSeedFile(
      'supabase/migrations/20260105000000_create_profiles.sql'
    );
    expect(migration).toMatch(
      /grant select \(id, display_name, joined_at\) on public\.profiles to app_reader/
    );
    expect(migration).not.toMatch(/grant select on (table )?public\.profiles/);
  });

  it('lists the members with select *', () => {
    expect(readSeedFile('scripts/list-profiles.sql')).toMatch(
      /select \* from public\.profiles/
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
      /42501|SQLSTATE|permission denied|column|grant|select \*|kb\/troubleshooting|supabase\.com/i
    );
  });
});
