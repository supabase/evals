import {
  maskSqlLiteralsAndComments,
  migrationCreatesTable,
} from '../lib/migrations.js';

export type SchemaChange = 'profiles' | 'bio' | 'posts' | 'avatar';

export const SCHEMA_CHANGES: readonly SchemaChange[] = [
  'profiles',
  'bio',
  'posts',
  'avatar',
];

const PROFILE_COLUMN_CHANGES = [
  ['bio', 'bio'],
  ['avatar', 'avatar_url'],
] as const;

const PROFILES_TABLE = '(?:"?public"?\\.)?"?profiles"?(?![\\w$"])';
const ALTER_PROFILES_RE = new RegExp(
  `^\\s*alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${PROFILES_TABLE}`
);
const CREATE_PROFILES_RE = new RegExp(
  `^\\s*create\\s+(?:unlogged\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${PROFILES_TABLE}\\s*\\(`,
  'i'
);
const TABLE_CONSTRAINT_KEYWORDS = new Set([
  'constraint',
  'primary',
  'unique',
  'check',
  'foreign',
  'like',
  'exclude',
]);

function foldUnquoted(statement: string): string {
  return statement.replace(/"[^"]*"|[^"]+/g, (part) =>
    part.startsWith('"') ? part : part.toLowerCase()
  );
}

function addsColumn(statement: string, column: string): boolean {
  return new RegExp(
    `\\badd\\s+(?:column\\s+)?(?:if\\s+not\\s+exists\\s+)?"?${column}"?(?![\\w$"])`
  ).test(statement);
}

function declaredColumns(statement: string, openParen: number): string[] {
  const entries: string[] = [];
  let depth = 0;
  let entryStart = openParen + 1;
  for (let i = openParen; i < statement.length; i++) {
    const char = statement[i];
    if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
      if (depth === 0) {
        entries.push(statement.slice(entryStart, i));
        break;
      }
    } else if (char === ',' && depth === 1) {
      entries.push(statement.slice(entryStart, i));
      entryStart = i + 1;
    }
  }
  return entries.flatMap((entry) => {
    const name = /^\s*(?:"([^"]+)"|([A-Za-z_][\w$]*))/.exec(entry);
    if (!name) return [];
    if (name[1] !== undefined) return [name[1]];
    const unquoted = name[2].toLowerCase();
    return TABLE_CONSTRAINT_KEYWORDS.has(unquoted) ? [] : [unquoted];
  });
}

function statementMakesColumn(statement: string, column: string): boolean {
  const folded = foldUnquoted(statement);
  if (ALTER_PROFILES_RE.test(folded)) return addsColumn(folded, column);
  const create = CREATE_PROFILES_RE.exec(statement);
  return (
    create !== null &&
    declaredColumns(statement, create.index + create[0].length - 1).includes(
      column
    )
  );
}

/** The scenario's schema changes `sql` makes, ignoring comments and string/dollar-quoted literals. */
export function migrationChanges(sql: string): SchemaChange[] {
  const found = new Set<SchemaChange>();
  if (migrationCreatesTable(sql, 'profiles')) found.add('profiles');
  if (migrationCreatesTable(sql, 'posts')) found.add('posts');
  for (const statement of maskSqlLiteralsAndComments(sql).split(';')) {
    for (const [change, column] of PROFILE_COLUMN_CHANGES) {
      if (statementMakesColumn(statement, column)) found.add(change);
    }
  }
  return SCHEMA_CHANGES.filter((change) => found.has(change));
}
