import { readdirSync, readFileSync } from 'node:fs';
import { parseEvalMarkdown } from '@supabase-evals/core/eval-markdown';
import { describe, expect, it } from 'vitest';
import { customMetadataSchema } from './custom-metadata.js';

const ids = readdirSync(new URL('./', import.meta.url), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory() && entry.name !== 'lib')
  .map((entry) => entry.name);

describe('customMetadataSchema', () => {
  it.each(ids)('accepts the %s prompt', (id) => {
    const { metadata } = parseEvalMarkdown(
      readFileSync(new URL(`./${id}/PROMPT.md`, import.meta.url), 'utf8'),
      `${id}/PROMPT.md`
    );
    expect(() =>
      customMetadataSchema.parse(metadata.customMetadata)
    ).not.toThrow();
  });
});
