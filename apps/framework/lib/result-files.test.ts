import { describe, expect, it } from 'vitest';
import { readPrompt } from './result-files.js';

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
