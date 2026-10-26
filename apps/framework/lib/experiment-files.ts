import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  evalSuiteSchema,
  type EvalSuite,
} from '@supabase-evals/core/eval-metadata';

const EXPERIMENT_SUFFIX = '.experiment.ts';

export type ExperimentFile = {
  name: string;
  /** The `experiments/<suite>/` folder, which pairs it with `evals/<suite>/`. */
  suite: EvalSuite;
  path: string;
};

export async function discoverExperimentFiles(
  experimentsDir: string
): Promise<ExperimentFile[]> {
  const files: ExperimentFile[] = [];

  for (const owner of await readdir(experimentsDir, { withFileTypes: true })) {
    if (
      !owner.isDirectory() ||
      owner.name.startsWith('.') ||
      owner.name.startsWith('_')
    ) {
      continue;
    }

    const suite = evalSuiteSchema.parse(owner.name);
    const ownerDir = join(experimentsDir, owner.name);
    for (const entry of await readdir(ownerDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(EXPERIMENT_SUFFIX)) continue;

      const name = entry.name.slice(0, -EXPERIMENT_SUFFIX.length);
      const path = join(ownerDir, entry.name);
      files.push({ name, suite, path });
    }
  }

  return files.sort(
    (a, b) => a.name.localeCompare(b.name) || a.suite.localeCompare(b.suite)
  );
}
