import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ARTICLE_URL, readSeedFile, SEEDED_CUSTOMERS } from './fixtures.js';

describe('resolve-cli-002 fixtures', () => {
  it('seeds each customer with an explicit id and does not advance the sequence', () => {
    const seed = readSeedFile('supabase/seed.sql');
    for (const row of SEEDED_CUSTOMERS) {
      const [id, email] = row.split('|');
      expect(seed).toContain(`(${id}, `);
      expect(seed).toContain(email);
    }
    expect(seed).not.toMatch(/setval|nextval/i);
  });

  it('keeps the signup script free of an id column', () => {
    expect(readSeedFile('scripts/add-customer.sql')).toMatch(
      /insert into public\.customers \(name, email\)/
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
    expect(prompt).not.toMatch(
      /23505|SQLSTATE|duplicate key|setval|sequence|kb\/troubleshooting|supabase\.com/i
    );
  });
});
