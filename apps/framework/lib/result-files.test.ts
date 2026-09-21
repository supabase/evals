import { describe, expect, it } from 'vitest';
import { readPrompt } from './result-files.js';

describe('readPrompt', () => {
  // The positive case is the control: without it a broken readPrompt that
  // always returned undefined would pass the traversal check below.
  it('reads a prompt for a real eval id', async () => {
    const found = await readPrompt('resolve-dataapi-001-empty-results');
    expect(found?.prompt).toBeTruthy();
    expect(found?.promptSourcePath).toBe(
      'evals/benchmark/resolve-dataapi-001-empty-results/PROMPT.md'
    );
  });

  it('refuses an eval id that climbs out of evals/', async () => {
    expect(await readPrompt('../../../etc/passwd')).toBeUndefined();
    expect(await readPrompt('../../package')).toBeUndefined();
  });
});
