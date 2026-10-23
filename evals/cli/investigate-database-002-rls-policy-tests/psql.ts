import { shellQuote } from '../lib/shell.js';

/** A `psql` command against `dbUrl` that stops at the first error, with `script` piped to stdin when given. */
export function psqlCommand(
  dbUrl: string,
  args: readonly string[],
  script?: string
): string {
  const psql = `psql ${shellQuote(dbUrl)} -X -A -t -q -v ON_ERROR_STOP=1 ${args.join(' ')}`;
  if (script === undefined) return psql;
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  return `printf %s ${shellQuote(encoded)} | base64 -d | ${psql}`;
}

export const compareText = (a: string, b: string) =>
  a < b ? -1 : a > b ? 1 : 0;
