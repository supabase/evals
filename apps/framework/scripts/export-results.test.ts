import { rawEvalResultSchema } from '@supabase-evals/core/eval-metadata';
import { describe, expect, it } from 'vitest';
import { readPrompt } from '../lib/result-files.js';
import { toEvalResult } from './export-results.js';

// build-docs-010-edge-function-auth is the one eval whose PROMPT.md pins
// `cliVersion: 2.109.1`, needed here to exercise the frontmatter side of the
// precedence.
const PINNED_EVAL_ID = 'build-docs-010-edge-function-auth';

describe('toEvalResult cliVersion precedence', () => {
  const build = async (raw: Record<string, unknown>) =>
    toEvalResult(
      rawEvalResultSchema.parse({
        experiment: 'test-experiment',
        eval: PINNED_EVAL_ID,
        interface: 'cli',
        ...raw,
      }),
      'test-experiment/run-1/result.json',
      await readPrompt(PINNED_EVAL_ID),
      undefined
    );

  it('carries the run value that actually ran over the frontmatter pin', async () => {
    const result = await build({ cliVersion: '2.118.0-beta.60' });
    expect(result.cliVersion).toBe('2.118.0-beta.60');
  });

  it('falls back to the frontmatter pin when the run recorded no version', async () => {
    const result = await build({});
    expect(result.cliVersion).toBe('2.109.1');
  });
});

describe('toEvalResult experimentRationale', () => {
  const display = {
    agent: 'claude-code',
    modelProvider: 'anthropic',
    modelId: 'claude-opus-5-5',
    reasoningEffort: 'medium',
  } as const;
  const experimentData = {
    display,
    rationale: { summary: 'Default model.', sources: [] },
    suites: [],
  };

  const build = async (experimentDisplay: Record<string, unknown>) =>
    toEvalResult(
      rawEvalResultSchema.parse({
        experiment: 'test-experiment',
        eval: PINNED_EVAL_ID,
        interface: 'cli',
        experimentDisplay,
      }),
      'test-experiment/run-1/result.json',
      await readPrompt(PINNED_EVAL_ID),
      experimentData
    );

  it('attaches the rationale when the run matches the config', async () => {
    expect((await build(display)).experimentRationale).toBeDefined();
  });

  it('drops the rationale when the run used a different effort', async () => {
    const result = await build({ ...display, reasoningEffort: 'high' });
    expect(result.experimentRationale).toBeUndefined();
  });
});
