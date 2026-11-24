import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateCustomMetadata } from './custom-metadata.js';
import { ROOT, readPrompt } from './result-files.js';

describe('validateCustomMetadata', () => {
  let withSchema: string;
  let withoutSchema: string;

  beforeAll(async () => {
    withSchema = await mkdtemp(join(tmpdir(), 'custom-metadata-'));
    withoutSchema = await mkdtemp(join(tmpdir(), 'custom-metadata-'));
    await writeFile(
      join(withSchema, 'custom-metadata.ts'),
      `import { z } from 'zod';
export const customMetadataSchema = z.strictObject({ area: z.enum(['a', 'b']) });
`
    );
  });

  afterAll(async () => {
    await rm(withSchema, { recursive: true, force: true });
    await rm(withoutSchema, { recursive: true, force: true });
  });

  it('returns the parsed value when it satisfies the suite schema', async () => {
    await expect(
      validateCustomMetadata(withSchema, { area: 'a' }, 'p/PROMPT.md')
    ).resolves.toEqual({ area: 'a' });
  });

  it('names the prompt path and the issue when the value is invalid', async () => {
    await expect(
      validateCustomMetadata(withSchema, { area: 'z' }, 'evals/s/x/PROMPT.md')
    ).rejects.toThrow(/evals\/s\/x\/PROMPT\.md[\s\S]*area/);
  });

  it('fails a required schema when customMetadata is missing', async () => {
    await expect(
      validateCustomMetadata(withSchema, undefined, 'p/PROMPT.md')
    ).rejects.toThrow(/p\/PROMPT\.md/);
  });

  it('passes customMetadata through when the suite has no schema', async () => {
    await expect(
      validateCustomMetadata(withoutSchema, { anything: 1 }, 'p/PROMPT.md')
    ).resolves.toEqual({ anything: 1 });
    await expect(
      validateCustomMetadata(withoutSchema, undefined, 'p/PROMPT.md')
    ).resolves.toBeUndefined();
  });

  it('accepts every real evals/cli prompt', async () => {
    const ids = (
      await readdir(join(ROOT, 'evals', 'cli'), { withFileTypes: true })
    )
      .filter((entry) => entry.isDirectory() && entry.name !== 'lib')
      .map((entry) => entry.name);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const prompt = await readPrompt(id);
      expect(prompt?.customMetadata, id).toBeDefined();
    }
  });
});
