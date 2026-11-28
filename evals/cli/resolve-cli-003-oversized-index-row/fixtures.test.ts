import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ARTICLE_URL,
  LONG_INSERT_SQL,
  readSeedFile,
  SEEDED_ARTICLES,
  UNIQUE_BODY_SQL,
} from './fixtures.js';

describe('resolve-cli-003 fixtures', () => {
  it('seeds each article', () => {
    const seed = readSeedFile('supabase/seed.sql');
    for (const row of SEEDED_ARTICLES) {
      const [slug, title] = row.split('|');
      expect(seed).toContain(`'${slug}'`);
      expect(seed).toContain(`'${title}'`);
    }
  });

  it('starts with a unique btree index on the body', () => {
    expect(
      readSeedFile('supabase/migrations/20260105000000_create_articles.sql')
    ).toMatch(
      /create unique index articles_body_key on public\.articles \(body\)/
    );
  });

  it('publishes a body above the 2704 byte btree limit', () => {
    const script = readSeedFile('scripts/publish-article.sql');
    const count = Number(script.match(/generate_series\(1, (\d+)\)/)?.[1]);
    expect(count * 32).toBeGreaterThan(2704);
    expect(LONG_INSERT_SQL).toContain(`generate_series(1, ${count})`);
    expect(UNIQUE_BODY_SQL).toContain(`generate_series(1, ${count})`);
  });

  it('keeps the scorer rows out of the seeded slugs', () => {
    for (const row of SEEDED_ARTICLES) {
      const slug = row.split('|')[0];
      expect(LONG_INSERT_SQL).not.toContain(`'${slug}'`);
      expect(UNIQUE_BODY_SQL).not.toContain(`'${slug}'`);
    }
  });

  it('never names the error, the article or the fix in the prompt', () => {
    const prompt = readFileSync(
      new URL('./PROMPT.md', import.meta.url),
      'utf8'
    );
    expect(prompt).not.toMatch(
      /54000|SQLSTATE|btree|index|md5|hash|kb\/troubleshooting|supabase\.com/i
    );
    expect(ARTICLE_URL).toMatch(
      /^https:\/\/supabase\.com\/kb\/troubleshooting\//
    );
  });
});
