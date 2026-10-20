import { fileURLToPath } from 'node:url';
import type { ExperimentConfig } from '@supabase-evals/core';
import type { LocalStackRuntimeOptions } from '@supabase-evals/sandbox';
import { describe, expect, it, vi } from 'vitest';
import { discoverExperimentFiles } from '../apps/framework/lib/experiment-files.js';
import { evalLocalStack } from './presets.js';

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

const experimentFiles = await discoverExperimentFiles(
  fileURLToPath(new URL('.', import.meta.url))
);
const localStackArms: { name: string; localStack: unknown }[] = [];
for (const { name, path } of experimentFiles) {
  const { default: experiment } = (await import(path)) as {
    default: ExperimentConfig;
  };
  if (experiment.localStack) {
    localStackArms.push({ name, localStack: experiment.localStack });
  }
}

describe('evalLocalStack', () => {
  it('keeps the arm env and always sets the eval tag', () => {
    const runtime = evalLocalStack({
      env: { SUPABASE_EVAL: '0', FOO: 'bar' },
    });

    expect(recordedOptions.get(runtime)?.env).toEqual({
      SUPABASE_EVAL: '1',
      FOO: 'bar',
    });
  });
});

describe('experiment local stacks', () => {
  it('discovers experiments that declare a local stack', () => {
    expect(localStackArms.length).toBeGreaterThan(0);
  });

  it.each(localStackArms.map((arm) => [arm.name, arm.localStack] as const))(
    '%s tags CLI runs with SUPABASE_EVAL=1',
    (_name, localStack) => {
      expect(recordedOptions.get(localStack)?.env?.SUPABASE_EVAL).toBe('1');
    }
  );
});
