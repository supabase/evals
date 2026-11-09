import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { collectResultFiles, readPrompt } from './result-files.js';
import { splitBySampleSetCompleteness } from './sample-sets.js';

const validResult = JSON.stringify({
  experiment: 'visible',
  eval: 'eval',
  interface: 'cli',
});

describe('readPrompt', () => {
  it('reads an existing prompt', async () => {
    const found = await readPrompt('resolve-dataapi-001-empty-results');
    expect(found?.prompt).toBeTruthy();
    expect(found?.promptSourcePath).toBe(
      'evals/benchmark/resolve-dataapi-001-empty-results/PROMPT.md'
    );
  });
});

describe('collectResultFiles', () => {
  it('keeps same-named experiments in separate suites', async () => {
    const resultsDir = await mkdtemp(join(tmpdir(), 'result-files-'));
    try {
      for (const suite of ['benchmark', 'regression']) {
        const path = join(
          resultsDir,
          suite,
          'visible',
          'eval',
          'run-1',
          'result.json'
        );
        await mkdir(dirname(path), { recursive: true });
        await writeFile(
          path,
          JSON.stringify({
            experiment: 'visible',
            suite,
            eval: 'eval',
            interface: 'cli',
            run: 1,
          })
        );
      }
      const files = await collectResultFiles({ resultsDir });
      expect(files.map(({ result }) => result.experiment)).toEqual([
        'visible',
        'visible',
      ]);
      expect(
        splitBySampleSetCompleteness(
          files.map(({ result }) => result),
          1
        ).complete
      ).toHaveLength(2);
    } finally {
      await rm(resultsDir, { recursive: true, force: true });
    }
  });

  it('rejects results that disagree with their suite or experiment folder', async () => {
    const resultsDir = await mkdtemp(join(tmpdir(), 'result-files-'));
    try {
      const path = join(
        resultsDir,
        'regression',
        'visible',
        'eval',
        'run-1',
        'result.json'
      );
      await mkdir(dirname(path), { recursive: true });
      for (const result of [
        { experiment: 'regression/visible', suite: 'regression' },
        { experiment: 'visible', suite: 'benchmark' },
      ]) {
        await writeFile(
          path,
          JSON.stringify({ ...result, eval: 'eval', interface: 'cli' })
        );
        expect(
          await collectResultFiles({
            resultsDir,
            includeSuite: (suite) => suite === 'cli',
          })
        ).toEqual([]);
        await expect(collectResultFiles({ resultsDir })).rejects.toThrow(
          'Rerun the eval'
        );
      }
    } finally {
      await rm(resultsDir, { recursive: true, force: true });
    }
  });

  it('selects valid runs from the canonical layout', async () => {
    const resultsDir = await mkdtemp(join(tmpdir(), 'result-files-'));
    try {
      for (const sourcePath of [
        'benchmark/visible/eval/run-2/result.json',
        'benchmark/visible/eval/run-1/result.json',
        'benchmark/visible/eval/run-x/result.json',
        'benchmark/visible/eval/run-3/result.json',
        'benchmark/visible/other/run-1/result.json',
        'benchmark/other/eval/run-1/result.json',
        '_hidden/visible/eval/run-1/result.json',
        'downloaded/raw-results-benchmark__visible__eval/eval/run-1/result.json',
      ]) {
        const absolutePath = join(resultsDir, sourcePath);
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(
          absolutePath,
          sourcePath.includes('run-3') ? '{}' : validResult
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
        'benchmark/visible/eval/run-1/result.json',
        'benchmark/visible/eval/run-2/result.json',
      ]);
      expect(onUnparseable).toHaveBeenCalledWith(
        'benchmark/visible/eval/run-3/result.json',
        expect.any(String)
      );
      expect(
        await collectResultFiles({
          resultsDir,
          includeExperiment: (experiment) => experiment === '_hidden/visible',
        })
      ).toEqual([]);
    } finally {
      await rm(resultsDir, { recursive: true, force: true });
    }
  });
});
