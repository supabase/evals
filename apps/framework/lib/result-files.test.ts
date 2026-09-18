import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { discoverResultFiles } from './result-files.js';

describe('discoverResultFiles', () => {
  it('finds canonical nested results without counting Vercel downloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'results-'));
    try {
      const canonical = join(
        dir,
        'cli',
        'codex-gpt-5.6-luna',
        'eval-1',
        'run-1',
        'result.json'
      );
      const downloaded = join(
        dir,
        'downloaded',
        'raw-results-cli',
        'codex-gpt-5.6-luna__eval-1',
        'eval-1',
        'run-1',
        'result.json'
      );
      await mkdir(join(canonical, '..'), { recursive: true });
      await mkdir(join(downloaded, '..'), { recursive: true });
      await writeFile(canonical, '{}');
      await writeFile(downloaded, '{}');

      await expect(discoverResultFiles(dir)).resolves.toEqual([canonical]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
