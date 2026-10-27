import {
  maskSqlLiteralsAndComments,
  stripSqlComments,
} from '../lib/migrations.js';
import { shellQuote } from '../lib/shell.js';

const PSQL_ERROR_RE = /^psql:(.+?):(\d+): ERROR:\s+(.*)$/m;
const CUT_MARK_RE = /\uE000(\d+)\uE001/g;
const CUT_RE = /;|^[ \t]*\\/gm;

/** The SQL with comments, whitespace and semicolons removed, so a migration file compares equal to the statements the CLI recorded for it. */
export function sqlFingerprint(sql: string): string {
  return stripSqlComments(sql).replace(/[\s;]/g, '');
}

/** The comment-free statements of `sql`, split on `;` outside string literals and dollar-quoted bodies, with empty ones dropped; a line starting with a backslash is a psql meta-command and a statement of its own. */
export function splitSqlStatements(sql: string): string[] {
  const stripped = stripSqlComments(sql);
  const cuts: { at: number; meta: boolean }[] = [];
  // Masking empties literals and dollar-quoted bodies, so only the marks at top-level cuts survive it.
  const marked = stripped.replace(CUT_RE, (match, offset: number) => {
    const meta = match !== ';';
    cuts.push({ at: meta ? offset + match.length - 1 : offset, meta });
    const mark = `\uE000${cuts.length - 1}\uE001`;
    return meta ? `${match.slice(0, -1)}${mark}\\` : `;${mark}`;
  });
  const topLevel = new Set(
    Array.from(
      maskSqlLiteralsAndComments(marked).matchAll(CUT_MARK_RE),
      (mark) => Number(mark[1])
    )
  );
  const statements: string[] = [];
  let start = 0;
  cuts.forEach(({ at, meta }, index) => {
    if (!topLevel.has(index) || at < start) return;
    if (meta) {
      const lineEnd = stripped.indexOf('\n', at);
      const end = lineEnd === -1 ? stripped.length : lineEnd;
      statements.push(stripped.slice(start, at), stripped.slice(at, end));
      start = end;
    } else {
      statements.push(stripped.slice(start, at));
      start = at + 1;
    }
  });
  statements.push(stripped.slice(start));
  return statements.map((statement) => statement.trim()).filter(Boolean);
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
