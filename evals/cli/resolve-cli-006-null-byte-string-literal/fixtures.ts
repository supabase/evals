import { readFileSync } from 'node:fs';

/** The article the CLI links for SQLSTATE 22021 (supabase/cli#7749). */
export const ARTICLE_URL =
  'https://supabase.com/kb/troubleshooting/error-invalid-byte-sequence-for-encoding-utf8-0x00-when-accessing-triggers-or-webhooks';

export const REGISTER_SCRIPT = 'scripts/register-asset.sql';

/** The seeded asset, as `id|path|label` (read as the admin role). */
export const SEEDED_ASSETS = ['1|C:\\ops\\raw\\scan-001.tif|first scan'];
export const SEEDED_ASSETS_SQL =
  'select id, path, label from public.assets order by id;';

/**
 * Checks that the registered path holds the backslashes as written. `E'...'`
 * reads them the same way under both settings of `standard_conforming_strings`.
 */
export const STORED_PATH_CHECK_SQL = String.raw`select path = E'C:\\0ps\\raw\\scan-002.tif' as stored_as_written from public.assets where label = 'second scan';`;

/** The scorer runs the workspace script in a transaction and rolls it back. */
export function registerInRolledBackTransaction(script: string): string {
  return `begin;\n${script.trimEnd()}\n${STORED_PATH_CHECK_SQL}\nrollback;\n`;
}

export function readSeedFile(path: string): string {
  return readFileSync(new URL(`./local/${path}`, import.meta.url), 'utf8');
}
