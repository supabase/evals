import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { discoverExperimentFiles } from './experiment-files.js';

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('discoverExperimentFiles', () => {
  it('discovers one owner layer and keeps experiment IDs stable', async () => {
    root = await mkdtemp(join(tmpdir(), 'eval-experiments-'));
    await mkdir(join(root, 'ai', 'lib'), { recursive: true });
    await mkdir(join(root, '_private'));
    await writeFile(join(root, 'presets.ts'), 'export {};');
    await writeFile(
      join(root, 'ai', 'model.experiment.ts'),
      'export default {};'
    );
    await writeFile(join(root, 'ai', 'support.ts'), 'export {};');
    await writeFile(
      join(root, 'ai', 'lib', 'nested.experiment.ts'),
      'export default {};'
    );
    await writeFile(
      join(root, '_private', 'hidden.experiment.ts'),
      'export default {};'
    );

    expect(await discoverExperimentFiles(root)).toEqual([
      {
        name: 'model',
        path: join(root, 'ai', 'model.experiment.ts'),
      },
    ]);
  });
});
