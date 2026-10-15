import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Directories that are never the agent's work. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.supabase',
  'supabase/.temp',
]);

export function walk(dir: string, root: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const rel = relative(root, full);
    if (SKIP_DIRS.has(entry) || SKIP_DIRS.has(rel)) continue;
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      out = out.concat(walk(full, root));
    } else if (info.size < 5_000_000) {
      out.push(full);
    }
  }
  return out;
}

export function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
