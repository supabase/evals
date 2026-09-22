import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const EXPERIMENT_SUFFIX = '.experiment.ts';

export type ExperimentFile = {
  name: string;
  path: string;
};

export async function discoverExperimentFiles(
  experimentsDir: string
): Promise<ExperimentFile[]> {
  const files: ExperimentFile[] = [];
  const experimentPaths = new Map<string, string>();

  for (const owner of await readdir(experimentsDir, { withFileTypes: true })) {
    if (
      !owner.isDirectory() ||
      owner.name.startsWith('.') ||
      owner.name.startsWith('_')
    ) {
      continue;
    }

    const ownerDir = join(experimentsDir, owner.name);
    for (const entry of await readdir(ownerDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(EXPERIMENT_SUFFIX)) continue;

      const name = entry.name.slice(0, -EXPERIMENT_SUFFIX.length);
      const path = join(ownerDir, entry.name);
      const duplicatePath = experimentPaths.get(name);

      if (duplicatePath) {
        throw new Error(
          `Duplicate experiment ID "${name}": ${[duplicatePath, path].sort().join(', ')}`
        );
      }

      experimentPaths.set(name, path);
      files.push({ name, path });
    }
  }

  return files.sort((a, b) => a.name.localeCompare(b.name));
}
