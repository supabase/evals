import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { discoverExperimentFiles } from './experiment-files.js';

describe('discoverExperimentFiles', () => {
  it('finds root and nested experiments but skips private and preset files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'experiments-'));
    try {
      await mkdir(join(dir, 'cli'));
      await mkdir(join(dir, 'ai'));
      await writeFile(join(dir, 'root.ts'), 'export default {}');
      await writeFile(join(dir, 'cli', 'arm.ts'), 'export default {}');
      await writeFile(join(dir, 'cli', '_baselines.ts'), 'export const x = 1');
      await writeFile(join(dir, 'cli', 'arm.test.ts'), 'export default {}');
      await writeFile(join(dir, 'presets.ts'), 'export const x = 1');
      await writeFile(join(dir, 'cli', 'presets.ts'), 'export const x = 1');
      await writeFile(
        join(dir, 'ai', 'codex-gpt-5.6-luna.ts'),
        'export default {}'
      );

      await expect(discoverExperimentFiles(dir)).resolves.toEqual([
        {
          name: 'ai/codex-gpt-5.6-luna',
          path: join(dir, 'ai', 'codex-gpt-5.6-luna.ts'),
        },
        { name: 'cli/arm', path: join(dir, 'cli', 'arm.ts') },
        { name: 'root', path: join(dir, 'root.ts') },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
