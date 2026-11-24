import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateCustomMetadata } from './custom-metadata.js';

describe('validateCustomMetadata', () => {
  let withSchema: string;
  let withoutSchema: string;
  let misnamed: string;

  beforeAll(async () => {
    withSchema = await mkdtemp(join(tmpdir(), 'custom-metadata-'));
    withoutSchema = await mkdtemp(join(tmpdir(), 'custom-metadata-'));
    misnamed = await mkdtemp(join(tmpdir(), 'custom-metadata-'));
    await writeFile(
      join(misnamed, 'custom-metadata.ts'),
      `import { z } from 'zod';
export const metadataSchema = z.object({});
`
    );
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
    await rm(misnamed, { recursive: true, force: true });
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
    ).rejects.toThrow(/p\/PROMPT\.md: .*Invalid input/);
  });

  it('rejects a custom-metadata.ts that does not export customMetadataSchema', async () => {
    await expect(
      validateCustomMetadata(misnamed, { a: 1 }, 'p/PROMPT.md')
    ).rejects.toThrow(/must export a zod customMetadataSchema/);
  });

  it('passes customMetadata through when the suite has no schema', async () => {
    await expect(
      validateCustomMetadata(withoutSchema, { anything: 1 }, 'p/PROMPT.md')
    ).resolves.toEqual({ anything: 1 });
    await expect(
      validateCustomMetadata(withoutSchema, undefined, 'p/PROMPT.md')
    ).resolves.toBeUndefined();
  });
});
