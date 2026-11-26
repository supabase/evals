import type { Dirent } from 'node:fs';

type ReadDir = (path: string) => Dirent[];

export function isSourcePath(path: string): boolean {
  const segments = path
    .split(/[\\/]/)
    .filter((segment) => segment !== '' && segment !== '.');
  if (
    segments.some((segment) => segment === 'node_modules' || segment === '.git')
  ) {
    return false;
  }
  if (segments[0] === 'supabase' && segments[1] === 'functions') {
    return false;
  }
  return /\.(ts|tsx|mts|cts)$/.test(segments[segments.length - 1] ?? '');
}

export function listSources(root: string, readDir: ReadDir): string[] {
  const found: string[] = [];
  const pending = [''];
  while (pending.length > 0) {
    const relative = pending.pop() ?? '';
    for (const entry of readDir(relative ? `${root}/${relative}` : root)) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (isSourcePath(`${child}/index.ts`)) pending.push(child);
      } else if (entry.isFile() && isSourcePath(child)) {
        found.push(child);
      }
    }
  }
  return found.sort();
}

export function collectSourcesScript(): string {
  return [
    'const __name = (target) => target;',
    "const fs = require('fs');",
    isSourcePath.toString(),
    listSources.toString(),
    'const readDir = (path) => fs.readdirSync(path, { withFileTypes: true });',
    'const out = {};',
    "for (const file of listSources('.', readDir)) out[file] = fs.readFileSync(file, 'utf8');",
    'process.stdout.write(JSON.stringify(out));',
  ].join('\n');
}
