import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { collectResultFiles, readPrompt } from './result-files.js';

describe('readPrompt', () => {
  it('reads an existing prompt', async () => {
    const found = await readPrompt('resolve-dataapi-001-empty-results');
    expect(found?.prompt).toBeTruthy();
    expect(found?.promptSourcePath).toBe(
      'evals/benchmark/resolve-dataapi-001-empty-results/PROMPT.md'
    );
  });

  it('rejects traversal outside evals/', async () => {
    expect(await readPrompt('../../../etc/passwd')).toBeUndefined();
    expect(await readPrompt('../../package')).toBeUndefined();
  });
});

describe('collectResultFiles', () => {
  it('selects valid runs from the canonical layout', async () => {
    const resultsDir = await mkdtemp(join(tmpdir(), 'result-files-'));
    try {
      const paths = [
        'visible/eval/run-2/result.json',
        'visible/eval/run-1/result.json',
        'visible/eval/run-x/result.json',
        'visible/eval/run-3/result.json',
        'visible/other/run-1/result.json',
        'visible/.hidden/run-1/result.json',
        '_hidden/eval/run-1/result.json',
      ];
      for (const sourcePath of paths) {
        const absolutePath = join(resultsDir, sourcePath);
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(
          absolutePath,
          sourcePath.includes('run-3')
            ? '{}'
            : JSON.stringify({
                experiment: 'visible',
                eval: 'eval',
                interface: 'cli',
              })
        );
      }

      const onUnparseable = vi.fn();
      const files = await collectResultFiles({
        resultsDir,
        includeExperiment: (experiment) => experiment === 'visible',
        includeEval: (evalId) => evalId === 'eval',
        onUnparseable,
      });
      expect(files.map((file) => file.sourcePath)).toEqual([
        'visible/eval/run-1/result.json',
        'visible/eval/run-2/result.json',
      ]);
      expect(onUnparseable).toHaveBeenCalledWith(
        'visible/eval/run-3/result.json',
        expect.any(String)
      );
      const hiddenEvalFiles = await collectResultFiles({
        resultsDir,
        includeEval: (evalId) => evalId === '.hidden',
      });
      expect(hiddenEvalFiles.map((file) => file.sourcePath)).toEqual([
        'visible/.hidden/run-1/result.json',
      ]);
    } finally {
      await rm(resultsDir, { recursive: true, force: true });
    }
  });
});
