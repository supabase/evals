import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

export async function discoverResultFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (
      entry.name === 'downloaded' ||
      entry.name.startsWith('.') ||
      entry.name.startsWith('_')
    )
      continue;

    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await discoverResultFiles(path)));
    } else if (
      entry.isFile() &&
      entry.name === 'result.json' &&
      /^run-\d+$/.test(basename(dir))
    ) {
      files.push(path);
    }
  }

  return files.sort();
}
