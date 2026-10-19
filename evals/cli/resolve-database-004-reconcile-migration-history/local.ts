import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { describeFailure, errorMessage, shellQuote } from '../lib/shell.js';
import { migrationChanges, type SchemaChange } from './changes.js';

export type LocalMigration = {
  file: string;
  version: string;
  changes: SchemaChange[];
};

export type LocalMigrationsProbe =
  | { ok: true; migrations: LocalMigration[] }
  | { ok: false; notes: string };

const MIGRATIONS_DIR = 'supabase/migrations';
const MIGRATION_FILE_RE = /^([0-9]+)_(.*)\.sql$/;
const KEPT_CHANGES = ['profiles', 'bio', 'avatar'] as const;

/** Orders versions shorter first, then lexically. */
export function compareVersions(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

export async function readLocalMigrations(
  ctx: Pick<LocalStackEvalContext, 'exec' | 'folderExists'>
): Promise<LocalMigrationsProbe> {
  try {
    if (!(await ctx.folderExists(MIGRATIONS_DIR))) {
      return { ok: false, notes: `${MIGRATIONS_DIR} does not exist` };
    }
    const listing = await ctx.exec(`ls ${MIGRATIONS_DIR}`);
    if (!listing.ok) {
      return {
        ok: false,
        notes: `could not list ${MIGRATIONS_DIR}: ${describeFailure(listing)}`,
      };
    }
    const migrations: LocalMigration[] = [];
    for (const line of listing.stdout.split('\n')) {
      const file = line.trim();
      const version = MIGRATION_FILE_RE.exec(file)?.[1];
      if (version === undefined) continue;
      const contents = await ctx.exec(
        `cat ${shellQuote(`${MIGRATIONS_DIR}/${file}`)}`
      );
      if (!contents.ok) {
        return {
          ok: false,
          notes: `could not read ${file}: ${describeFailure(contents)}`,
        };
      }
      migrations.push({
        file,
        version,
        changes: migrationChanges(contents.stdout),
      });
    }
    migrations.sort((a, b) => compareVersions(a.version, b.version));
    return { ok: true, migrations };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

export function checkLocalChangesKept(
  local: LocalMigrationsProbe
): CheckResult {
  const name = 'local migrations still make every seeded change';
  if (!local.ok) return { name, passed: false, notes: local.notes };
  const makers = KEPT_CHANGES.map((change) => ({
    change,
    files: local.migrations
      .filter(({ changes }) => changes.includes(change))
      .map(({ file }) => file),
  }));
  const missing = makers.filter(({ files }) => files.length === 0);
  return missing.length > 0
    ? {
        name,
        passed: false,
        notes: `no local migration makes: ${missing.map(({ change }) => change).join(', ')}`,
      }
    : {
        name,
        passed: true,
        notes: makers
          .map(({ change, files }) => `${change}: ${files.join(', ')}`)
          .join('; '),
      };
}
