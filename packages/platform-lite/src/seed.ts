import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EdgeFunctionSeed, ProjectSeed, LogRow } from './types.js';

export async function loadSeedDir(dir: string): Promise<ProjectSeed[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  );
  if (!entries) return [];
  const seeds: ProjectSeed[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = join(dir, entry.name);
    const seed: ProjectSeed = { ref: entry.name, name: entry.name };

    const sqlPath = join(projectDir, 'project.sql');
    try {
      seed.sql = await readFile(sqlPath, 'utf-8');
    } catch {
      // optional
    }

    const logsPath = join(projectDir, 'logs.jsonl');
    try {
      const raw = await readFile(logsPath, 'utf-8');
      seed.logs = raw
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          const obj = JSON.parse(line) as {
            id?: string;
            ts?: string;
            source?: string;
            level?: string;
            message?: string;
            metadata?: Record<string, unknown>;
          };
          return {
            id: obj.id,
            ts: obj.ts ? new Date(obj.ts) : new Date(),
            source: obj.source ?? 'unknown',
            level: obj.level ?? 'info',
            message: obj.message ?? '',
            metadata: obj.metadata,
          } satisfies LogRow;
        });
    } catch {
      // optional
    }

    seed.functions = await loadFunctionSeeds(join(projectDir, 'functions'));

    seeds.push(seed);
  }

  return seeds;
}

/**
 * Read a `functions/` directory into `EdgeFunctionSeed[]`, one entry per
 * subdirectory (`functions/<slug>/*`). Returns `[]` if the directory is absent.
 */
export async function loadFunctionSeeds(
  dir: string
): Promise<EdgeFunctionSeed[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  );
  if (!entries) return [];

  const functions: EdgeFunctionSeed[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const functionDir = join(dir, entry.name);
    const files = await loadFunctionFiles(functionDir);
    if (files.length) {
      functions.push({ slug: entry.name, files });
    }
  }

  return functions;
}

async function loadFunctionFiles(
  dir: string
): Promise<Array<{ name: string; content: string }>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: Array<{ name: string; content: string }> = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    files.push({
      name: entry.name,
      content: await readFile(join(dir, entry.name), 'utf-8'),
    });
  }

  return files.sort((a, b) => a.name.localeCompare(b.name));
}
