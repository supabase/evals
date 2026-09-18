import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export type ExperimentFile = {
  name: string;
  path: string;
};

export async function discoverExperimentFiles(
  experimentsDir: string
): Promise<ExperimentFile[]> {
  const files: ExperimentFile[] = [];

  async function visit(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;

      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }

      if (
        !entry.isFile() ||
        !entry.name.endsWith('.ts') ||
        entry.name.endsWith('.test.ts') ||
        entry.name === 'presets.ts'
      )
        continue;
      files.push({
        name: relative(experimentsDir, path).slice(0, -3).split(sep).join('/'),
        path,
      });
    }
  }

  await visit(experimentsDir);
  return files.sort((a, b) => a.name.localeCompare(b.name));
}
