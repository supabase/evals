import { fileURLToPath } from 'node:url';
import type { ExperimentConfig } from '@supabase-evals/core';
import type { LocalStackRuntimeOptions } from '@supabase-evals/sandbox';
import { describe, expect, it, vi } from 'vitest';
import { discoverExperimentFiles } from '../../../apps/framework/lib/experiment-files.js';

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

const experimentsRoot = fileURLToPath(new URL('../../', import.meta.url));
const cliRoot = fileURLToPath(new URL('../', import.meta.url));
const cliExperimentFiles = (
  await discoverExperimentFiles(experimentsRoot)
).filter(({ path }) => path.startsWith(cliRoot));
const cliArms: { name: string; experiment: ExperimentConfig }[] = [];
for (const { name, path } of cliExperimentFiles) {
  const { default: experiment } = (await import(path)) as {
    default: ExperimentConfig;
  };
  cliArms.push({ name, experiment });
}

describe('CLI experiment local stacks', () => {
  it('discovers CLI experiments', () => {
    expect(cliArms.length).toBeGreaterThan(0);
  });

  it.each(cliArms.map((arm) => [arm.name, arm.experiment] as const))(
    '%s tags CLI runs with SUPABASE_EVAL=1',
    (_name, experiment) => {
      expect(experiment.localStack).toBeDefined();
      expect(
        recordedOptions.get(experiment.localStack)?.env?.SUPABASE_EVAL
      ).toBe('1');
    }
  );
});
