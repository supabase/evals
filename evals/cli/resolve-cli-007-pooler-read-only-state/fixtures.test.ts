import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ARTICLE_URL, POOLER_URL, readSeedFile } from './fixtures.js';

describe('resolve-cli-007 fixtures', () => {
  it('enables the transaction pooler on the port the prompt uses', () => {
    const config = readSeedFile('supabase/config.toml');
    expect(config).toMatch(/\[db\.pooler\]\nenabled = true\nport = 54329/);
    expect(config).toMatch(/pool_mode = "transaction"/);
    expect(POOLER_URL).toContain(':54329/');
  });

  it('starts the report with a session-level read-only setting', () => {
    expect(readSeedFile('scripts/nightly-report.sql')).toMatch(
      /^set default_transaction_read_only = on;$/m
    );
  });

  it('keeps the signup insert to one statement for db query', () => {
    expect(readSeedFile('scripts/add-order.sql')).toMatch(
      /insert into public\.orders \(item\) values/
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
      /25006|SQLSTATE|default_transaction|session|transaction|state|kb\/troubleshooting|supabase\.com/i
    );
  });
});
