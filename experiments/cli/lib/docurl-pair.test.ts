import type { EvalMetadata } from '@supabase-evals/core';
import type { LocalStackRuntimeOptions } from '@supabase-evals/sandbox';
import { describe, expect, it, vi } from 'vitest';
import { claudeCodeSonnet55, codexGpt6Luna } from '../../presets.js';
import {
  DOCURL_OFF_VERSION,
  DOCURL_ON_VERSION,
  docUrlExperiment,
} from './docurl-pair.js';

const recordedOptions = vi.hoisted(
  () => new Map<unknown, LocalStackRuntimeOptions>()
);

vi.mock('@supabase-evals/sandbox', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@supabase-evals/sandbox')>();
  return {
    ...actual,
    localStackRuntime: (options: LocalStackRuntimeOptions = {}) => {
      const runtime = actual.localStackRuntime(options);
      recordedOptions.set(runtime, options);
      return runtime;
    },
  };
});

const baseMetadata: EvalMetadata = {
  stage: 'resolve',
  product: ['database'],
  topic: ['sql'],
  interface: 'cli',
};
const abEval = {
  id: 'ab',
  metadata: { ...baseMetadata, customMetadata: { abGroup: 'cli-docurl' } },
};
const plainEval = { id: 'plain', metadata: baseMetadata };

describe('docUrlExperiment', () => {
  it('pins the CLI version and tags CLI runs as eval traffic', () => {
    const experiment = docUrlExperiment(claudeCodeSonnet55, '9.9.9');
    expect(recordedOptions.get(experiment.localStack)).toEqual({
      cliVersion: '9.9.9',
      env: { SUPABASE_EVAL: '1' },
    });
  });

  it('keeps the preset agent', () => {
    expect(docUrlExperiment(codexGpt6Luna, '9.9.9').agent).toBe(
      codexGpt6Luna.agent
    );
  });

  it('runs only the docUrl A/B evals', () => {
    const { skipEval } = docUrlExperiment(claudeCodeSonnet55, '9.9.9');
    expect(skipEval?.(abEval)).toBe(false);
    expect(skipEval?.(plainEval)).toBe(true);
  });

  it('names an exact release for each arm', () => {
    expect(DOCURL_OFF_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
    expect(DOCURL_ON_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
  });
});
