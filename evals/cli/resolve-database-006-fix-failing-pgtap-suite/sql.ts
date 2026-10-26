import { stripSqlComments } from '../lib/migrations.js';
import { shellQuote } from '../lib/shell.js';

const PSQL_ERROR_RE = /^psql:(.+?):(\d+): ERROR:\s+(.*)$/m;

/** The SQL with comments, whitespace and semicolons removed, so a migration file compares equal to the statements the CLI recorded for it. */
export function sqlFingerprint(sql: string): string {
  return stripSqlComments(sql).replace(/[\s;]/g, '');
}

/** A `psql` command against `dbUrl` that runs quietly and stops at the first error. */
export function psqlCommand(dbUrl: string, args: string): string {
  return `psql ${shellQuote(dbUrl)} -X -A -t -q -v ON_ERROR_STOP=1 ${args}`;
}

/** `dbUrl` pointing at another database on the same server, query string kept. */
export function withDatabase(dbUrl: string, database: string): string {
  const url = new URL(dbUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** The first statement error psql printed as `<file>:<line>: <message>`, else its first line of output. */
export function readPsqlError(stderr: string): string | undefined {
  const match = PSQL_ERROR_RE.exec(stderr);
  if (match !== null) return `${match[1]}:${match[2]}: ${match[3].trim()}`;
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
}
