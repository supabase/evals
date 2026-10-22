import type { LocalStackEvalContext } from '@supabase-evals/core';
import { describeFailure, shellQuote } from '../lib/shell.js';
import { readSeedFile, SEEDED_MIGRATIONS } from './fixtures.js';
import type { ReplayFile } from './probe.js';

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;

export type WorkspaceSql =
  | { ok: true; migrations: ReplayFile[]; seed?: ReplayFile }
  | { ok: false; notes: string };

const MIGRATIONS_DIR = 'supabase/migrations';
const SEED_PATH = 'supabase/seed.sql';
const MIGRATION_FILE_RE = /^(\d+)_(.+)\.sql$/;

/** The migration files in version order, and the seed file when the project has one. */
export async function readWorkspaceSql(
  ctx: ExecContext
): Promise<WorkspaceSql> {
  const listing = await ctx.exec(`ls -1 ${MIGRATIONS_DIR}`);
  if (!listing.ok) {
    return {
      ok: false,
      notes: `could not list ${MIGRATIONS_DIR}: ${describeFailure(listing)}`,
    };
  }
  const names = listing.stdout
    .split('\n')
    .filter((name) => MIGRATION_FILE_RE.test(name))
    .sort();
  if (names.length === 0) {
    return { ok: false, notes: `no migration files in ${MIGRATIONS_DIR}` };
  }

  const migrations: ReplayFile[] = [];
  for (const name of names) {
    const path = `${MIGRATIONS_DIR}/${name}`;
    const read = await ctx.exec(`cat ${shellQuote(path)}`);
    if (!read.ok) {
      return {
        ok: false,
        notes: `could not read ${name}: ${describeFailure(read)}`,
      };
    }
    migrations.push({ name, sql: read.stdout });
  }

  const hasSeed = await ctx.exec(`test -f ${shellQuote(SEED_PATH)}`);
  if (!hasSeed.ok) return { ok: true, migrations };
  const seed = await ctx.exec(`cat ${shellQuote(SEED_PATH)}`);
  if (!seed.ok) {
    return {
      ok: false,
      notes: `could not read seed.sql: ${describeFailure(seed)}`,
    };
  }
  return { ok: true, migrations, seed: { name: 'seed.sql', sql: seed.stdout } };
}

/** The files in the order `supabase db reset` applies them. */
export function replayFiles(
  sql: Extract<WorkspaceSql, { ok: true }>
): ReplayFile[] {
  return sql.seed === undefined
    ? sql.migrations
    : [...sql.migrations, sql.seed];
}

/** How the workspace's migration files differ from the seeded ones, comparing contents after `trim()`. */
export function diffSeededMigrations(files: readonly ReplayFile[]): {
  added: string[];
  modified: string[];
  missing: string[];
} {
  const byName = new Map(files.map(({ name, sql }) => [name, sql]));
  return {
    added: files
      .map(({ name }) => name)
      .filter((name) => !SEEDED_MIGRATIONS.includes(name)),
    modified: SEEDED_MIGRATIONS.filter((name) => {
      const sql = byName.get(name);
      return (
        sql !== undefined &&
        sql.trim() !== readSeedFile(`supabase/migrations/${name}`).trim()
      );
    }),
    missing: SEEDED_MIGRATIONS.filter((name) => !byName.has(name)),
  };
}
