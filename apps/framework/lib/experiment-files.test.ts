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
  it('discovers one suite layer and keeps experiment IDs stable', async () => {
    root = await mkdtemp(join(tmpdir(), 'eval-experiments-'));
    await mkdir(join(root, 'regression', 'lib'), { recursive: true });
    await mkdir(join(root, '_private'));
    await writeFile(join(root, 'presets.ts'), 'export {};');
    await writeFile(
      join(root, 'regression', 'model.experiment.ts'),
      'export default {};'
    );
    await writeFile(join(root, 'regression', 'support.ts'), 'export {};');
    await writeFile(
      join(root, 'regression', 'lib', 'nested.experiment.ts'),
      'export default {};'
    );
    await writeFile(
      join(root, '_private', 'hidden.experiment.ts'),
      'export default {};'
    );

    expect(await discoverExperimentFiles(root)).toEqual([
      {
        name: 'model',
        suite: 'regression',
        path: join(root, 'regression', 'model.experiment.ts'),
      },
    ]);
  });

  it('keeps the same experiment ID in several suite folders', async () => {
    root = await mkdtemp(join(tmpdir(), 'eval-experiments-'));
    await mkdir(join(root, 'benchmark'));
    await mkdir(join(root, 'docs'));
    await writeFile(
      join(root, 'benchmark', 'model.experiment.ts'),
      'export default {};'
    );
    await writeFile(
      join(root, 'docs', 'model.experiment.ts'),
      'export default {};'
    );

    expect(await discoverExperimentFiles(root)).toEqual([
      {
        name: 'model',
        suite: 'benchmark',
        path: join(root, 'benchmark', 'model.experiment.ts'),
      },
      {
        name: 'model',
        suite: 'docs',
        path: join(root, 'docs', 'model.experiment.ts'),
      },
    ]);
  });

  it('rejects a folder that is not an eval suite', async () => {
    root = await mkdtemp(join(tmpdir(), 'eval-experiments-'));
    await mkdir(join(root, 'ai'));

    await expect(discoverExperimentFiles(root)).rejects.toThrow();
  });
});
