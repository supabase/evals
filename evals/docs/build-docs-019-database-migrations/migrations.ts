import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckResult } from '@supabase-evals/core';

export type MigrationFile = { name: string; version: string; sql: string };

const SEED_DIR = new URL('./local/supabase/migrations/', import.meta.url);

// The CLI runs `<digits>_<anything>.sql` and skips every other file.
const RUNNABLE = /^(\d+)_.*\.sql$/;

export const CHECK = {
  history: 'the migrations that were already in the repo are untouched',
  added:
    'the change is in a new migration file that sorts after the existing ones',
} as const;

/** The migrations the eval ships, read from the seed rather than copied. */
export function seedMigrations(): MigrationFile[] {
  const seed = readMigrations(fileURLToPath(SEED_DIR));
  // An empty seed would make the history check pass on nothing.
  if (seed.length === 0) {
    throw new Error(`no seed migrations found in ${fileURLToPath(SEED_DIR)}`);
  }
  return seed;
}

/** What the agent's workspace holds. Empty when there is no folder. */
export function workspaceMigrations(hostWorkspace: string): MigrationFile[] {
  return readMigrations(join(hostWorkspace, 'supabase', 'migrations'));
}

function readMigrations(dir: string): MigrationFile[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      version: RUNNABLE.exec(name)?.[1] ?? '',
      sql: readFileSync(join(dir, name), 'utf8'),
    }));
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

// The seed's files are what production already runs, so a change to one of
// them, or a missing one, never reaches a database that has applied it.
export function checkHistoryUntouched(
  seed: MigrationFile[],
  workspace: MigrationFile[]
): CheckResult {
  const byName = new Map(workspace.map((file) => [file.name, file]));
  const edited: string[] = [];
  const missing: string[] = [];
  for (const file of seed) {
    const found = byName.get(file.name);
    if (!found) missing.push(file.name);
    else if (sha(found.sql) !== sha(file.sql)) edited.push(file.name);
  }
  const problems = [
    edited.length > 0 ? `edited: ${edited.join(', ')}` : '',
    missing.length > 0 ? `missing or renamed: ${missing.join(', ')}` : '',
  ].filter(Boolean);
  return {
    name: CHECK.history,
    passed: problems.length === 0,
    notes:
      problems.length === 0
        ? 'every shipped file is byte-identical'
        : problems.join('; '),
  };
}

/** The workspace's runnable files the seed doesn't have, in the order they run. */
export function addedMigrations(
  seed: MigrationFile[],
  workspace: MigrationFile[]
): MigrationFile[] {
  const shipped = new Set(seed.map((file) => file.name));
  return workspace
    .filter((file) => !shipped.has(file.name) && file.version !== '')
    .sort((a, b) => compareVersions(a.version, b.version));
}

export function checkAddedMigration(
  seed: MigrationFile[],
  workspace: MigrationFile[]
): CheckResult {
  const added = addedMigrations(seed, workspace);
  const shipped = new Set(seed.map((file) => file.name));
  const skipped = workspace.filter(
    (file) => !shipped.has(file.name) && file.version === ''
  );
  const last =
    seed
      .map((file) => file.version)
      .sort(compareVersions)
      .at(-1) ?? '';
  const early = added.filter(
    (file) => compareVersions(file.version, last) <= 0
  );

  if (added.length === 0) {
    return {
      name: CHECK.added,
      passed: false,
      notes:
        skipped.length > 0
          ? `no new migration the CLI would run; it skips ${skipped.map((file) => file.name).join(', ')}`
          : 'no migration file beyond the ones that were already there',
    };
  }
  if (early.length > 0) {
    return {
      name: CHECK.added,
      passed: false,
      notes: `${early.map((file) => file.name).join(', ')} sorts at or before ${last}, which production has already applied`,
    };
  }
  return {
    name: CHECK.added,
    passed: true,
    notes: `new: ${added.map((file) => file.name).join(', ')}`,
  };
}

function compareVersions(a: string, b: string): number {
  const x = BigInt(a || '0');
  const y = BigInt(b || '0');
  return x < y ? -1 : x > y ? 1 : 0;
}
