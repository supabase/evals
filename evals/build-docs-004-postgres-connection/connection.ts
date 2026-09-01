import { basename, extname } from 'node:path';
import ts from 'typescript';
import type { CheckResult } from '@supabase-evals/core';

import { readText, walk } from './files.js';

export const PROJECT_REF = 'qwltzrndbfhkxmpvsjac';
export const POOLER_HOST = 'aws-1-us-east-2.pooler.supabase.com';
export const DIRECT_HOST = `db.${PROJECT_REF}.supabase.co`;
export const POOLER_USER = `postgres.${PROJECT_REF}`;

export type Endpoint = {
  label: string;
  host: string;
  port: number;
  user: string;
};

export const ENDPOINTS: Endpoint[] = [
  { label: 'direct', host: DIRECT_HOST, port: 5432, user: 'postgres' },
  { label: 'session pooler', host: POOLER_HOST, port: 5432, user: POOLER_USER },
  {
    label: 'transaction pooler',
    host: POOLER_HOST,
    port: 6543,
    user: POOLER_USER,
  },
];

const TRANSACTION_POOLER = ENDPOINTS[2];
const DIRECT = ENDPOINTS[0];

export type Workspace = { root: string; files: Map<string, string> };

const SOURCE_EXTENSIONS = new Set([
  '.mjs',
  '.cjs',
  '.js',
  '.jsx',
  '.mts',
  '.cts',
  '.ts',
  '.tsx',
]);

export function loadWorkspace(root: string): Workspace {
  const files = new Map<string, string>();
  for (const path of walk(root, root)) {
    files.set(path.slice(root.length + 1), readText(path));
  }
  return { root, files };
}

function isEnvFile(rel: string): boolean {
  return /^\.env(\..+)?$/.test(basename(rel));
}

function isSourceFile(rel: string): boolean {
  return (
    SOURCE_EXTENSIONS.has(extname(rel)) &&
    !rel.startsWith('supabase/functions/')
  );
}

function scriptKind(rel: string): ts.ScriptKind {
  const ext = extname(rel);
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.jsx') return ts.ScriptKind.JSX;
  if (ext === '.ts' || ext === '.mts' || ext === '.cts')
    return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

export type Dsn = {
  raw: string;
  host: string;
  port: number;
  user: string;
};

export function parseDsn(raw: string): Dsn | undefined {
  if (!/^postgres(ql)?:\/\//i.test(raw)) return undefined;
  try {
    const url = new URL(raw);
    return {
      raw,
      host: url.hostname,
      port: url.port ? Number(url.port) : 5432,
      user: decodeURIComponent(url.username),
    };
  } catch {
    return undefined;
  }
}

export function classifyDsn(dsn: Dsn): Endpoint | undefined {
  return ENDPOINTS.find(
    (endpoint) =>
      endpoint.host === dsn.host &&
      endpoint.port === dsn.port &&
      endpoint.user === dsn.user
  );
}

export function readEnvFiles(ws: Workspace): Map<string, string> {
  const values = new Map<string, string>();
  for (const [rel, text] of ws.files) {
    if (!isEnvFile(rel)) continue;
    for (const line of text.split('\n')) {
      const match =
        /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const value = match[2].trim().replace(/^['"]|['"]$/g, '');
      if (value) values.set(match[1], value);
    }
  }
  return values;
}

export type ClientSite = {
  file: string;
  insideFunction: boolean;
  envNames: string[];
  literals: string[];
  prepare?: boolean;
  max?: number;
};

export type Analysis = {
  clientSites: ClientSite[];
  importsPostgresJs: boolean;
  envValues: Map<string, string>;
  hostsInWorkspace: { file: string; host: string }[];
  hardcodedDsns: { file: string; raw: string }[];
};

function collectEnvNames(node: ts.Node): string[] {
  const names: string[] = [];
  const visit = (current: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      ts.isIdentifier(current.expression.expression) &&
      current.expression.expression.text === 'process' &&
      current.expression.name.text === 'env'
    ) {
      names.push(current.name.text);
    }
    if (
      ts.isElementAccessExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      ts.isIdentifier(current.expression.expression) &&
      current.expression.expression.text === 'process' &&
      current.expression.name.text === 'env' &&
      current.argumentExpression &&
      ts.isStringLiteralLike(current.argumentExpression)
    ) {
      names.push(current.argumentExpression.text);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return names;
}

function collectStringLiterals(node: ts.Node): string[] {
  const out: string[] = [];
  const visit = (current: ts.Node) => {
    if (ts.isStringLiteralLike(current)) out.push(current.text);
    if (ts.isNoSubstitutionTemplateLiteral(current)) out.push(current.text);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return out;
}

function isInsideFunction(node: ts.Node): boolean {
  let current = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function booleanOf(node: ts.Expression): boolean | undefined {
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function numberOf(node: ts.Expression): number | undefined {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  return undefined;
}

function readOptions(node: ts.Expression | undefined): {
  prepare?: boolean;
  max?: number;
} {
  if (!node || !ts.isObjectLiteralExpression(node)) return {};
  const out: { prepare?: boolean; max?: number } = {};
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = ts.isIdentifier(property.name)
      ? property.name.text
      : ts.isStringLiteralLike(property.name)
        ? property.name.text
        : undefined;
    if (key === 'prepare') out.prepare = booleanOf(property.initializer);
    if (key === 'max') out.max = numberOf(property.initializer);
  }
  return out;
}

export function analyze(ws: Workspace): Analysis {
  const clientSites: ClientSite[] = [];
  const hostsInWorkspace: { file: string; host: string }[] = [];
  const hardcodedDsns: { file: string; raw: string }[] = [];
  let importsPostgresJs = false;

  for (const [rel, text] of ws.files) {
    for (const match of text.matchAll(
      /\b((?:aws-[0-9a-z-]+\.)?pooler\.supabase\.com|db\.[a-z0-9]+\.supabase\.(?:co|red))\b/gi
    )) {
      hostsInWorkspace.push({ file: rel, host: match[1] });
    }
    if (!isSourceFile(rel)) continue;
    for (const match of text.matchAll(/postgres(?:ql)?:\/\/[^\s'"`)]+/gi)) {
      hardcodedDsns.push({ file: rel, raw: match[0] });
    }

    const source = ts.createSourceFile(
      rel,
      text,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(rel)
    );
    const factories = new Set<string>();
    const topLevelBindings = new Map<string, ts.Expression>();

    for (const statement of source.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteralLike(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === 'postgres' &&
        statement.importClause?.name
      ) {
        factories.add(statement.importClause.name.text);
        importsPostgresJs = true;
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer) {
            topLevelBindings.set(
              declaration.name.text,
              declaration.initializer
            );
            if (
              ts.isCallExpression(declaration.initializer) &&
              ts.isIdentifier(declaration.initializer.expression) &&
              declaration.initializer.expression.text === 'require' &&
              declaration.initializer.arguments.length === 1 &&
              ts.isStringLiteralLike(declaration.initializer.arguments[0]) &&
              declaration.initializer.arguments[0].text === 'postgres'
            ) {
              factories.add(declaration.name.text);
              importsPostgresJs = true;
            }
          }
        }
      }
    }

    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        factories.has(node.expression.text)
      ) {
        const [first, second] = node.arguments;
        const envNames = first ? collectEnvNames(first) : [];
        const literals = first ? collectStringLiterals(first) : [];
        if (first && ts.isIdentifier(first)) {
          const bound = topLevelBindings.get(first.text);
          if (bound) {
            envNames.push(...collectEnvNames(bound));
            literals.push(...collectStringLiterals(bound));
          }
        }
        const options =
          first && ts.isObjectLiteralExpression(first)
            ? readOptions(first)
            : readOptions(second);
        clientSites.push({
          file: rel,
          insideFunction: isInsideFunction(node),
          envNames: [...new Set(envNames)],
          literals: literals.filter((value) => parseDsn(value) !== undefined),
          ...options,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return {
    clientSites,
    importsPostgresJs,
    envValues: readEnvFiles(ws),
    hostsInWorkspace,
    hardcodedDsns,
  };
}

const FIXTURE_FILE = 'CONNECT.md';
const MIGRATION_HINT = /migrat|non_?pooling|direct/i;

export function resolveRuntimeDsns(analysis: Analysis, ws: Workspace): Dsn[] {
  const out: Dsn[] = [];
  for (const site of analysis.clientSites) {
    for (const name of site.envNames) {
      const value = analysis.envValues.get(name);
      const dsn = value ? parseDsn(value) : undefined;
      if (dsn) out.push(dsn);
    }
    for (const literal of site.literals) {
      const dsn = parseDsn(literal);
      if (dsn) out.push(dsn);
    }
  }
  if (out.length > 0) return out;

  for (const [rel, text] of ws.files) {
    if (rel === FIXTURE_FILE || isSourceFile(rel)) continue;
    for (const match of text.matchAll(/postgres(?:ql)?:\/\/[^\s'"`)]+/gi)) {
      const dsn = parseDsn(match[0]);
      if (dsn && !MIGRATION_HINT.test(rel)) out.push(dsn);
    }
  }
  return out;
}

function migrationDsns(analysis: Analysis): Dsn[] {
  const out: Dsn[] = [];
  for (const [name, value] of analysis.envValues) {
    if (!MIGRATION_HINT.test(name)) continue;
    const dsn = parseDsn(value);
    if (dsn) out.push(dsn);
  }
  return out;
}

export function fileChecks(ws: Workspace): CheckResult[] {
  const analysis = analyze(ws);
  const runtime = resolveRuntimeDsns(analysis, ws);
  const classified = runtime.map((dsn) => ({
    dsn,
    endpoint: classifyDsn(dsn),
  }));
  const pooled = classified.filter(
    (entry) => entry.endpoint?.host === POOLER_HOST
  );
  const onTransactionPooler = classified.some(
    (entry) => entry.endpoint === TRANSACTION_POOLER
  );
  const sites = analysis.clientSites;
  const NO_CLIENT = 'no postgres-js client found in application source';
  const describe = (value: unknown) =>
    value === undefined ? 'unset' : String(value);

  const runtimeNotes = classified.length
    ? classified
        .map(
          (entry) =>
            `${entry.dsn.user}@${entry.dsn.host}:${entry.dsn.port} (${entry.endpoint?.label ?? 'not a CONNECT.md endpoint'})`
        )
        .join(', ')
    : analysis.clientSites.length
      ? `client at ${analysis.clientSites.map((entry) => entry.file).join(', ')} resolves no connection string from the environment`
      : 'no postgres-js client found in application source';

  const knownHosts = new Set(ENDPOINTS.map((endpoint) => endpoint.host));
  const unknownHosts = analysis.hostsInWorkspace.filter(
    (entry) => !knownHosts.has(entry.host)
  );

  const migrations = migrationDsns(analysis);
  const migrationsOnDirect = migrations.every(
    (dsn) => classifyDsn(dsn) === DIRECT
  );

  return [
    {
      name: 'the transaction pooler string is what the app reads at runtime',
      passed: onTransactionPooler,
      notes: runtimeNotes,
    },
    {
      name: 'prepared statements are turned off on the pooled connection',
      passed:
        pooled.length === 0
          ? true
          : sites.length > 0 && sites.every((entry) => entry.prepare === false),
      notes:
        pooled.length === 0
          ? 'not applicable, the connection is not pooled'
          : sites.length === 0
            ? NO_CLIENT
            : sites
                .map(
                  (entry) => `${entry.file} prepare ${describe(entry.prepare)}`
                )
                .join(', '),
    },
    {
      name: 'the connection pool is capped for a serverless invocation',
      passed:
        sites.length > 0 &&
        sites.every((entry) => entry.max !== undefined && entry.max <= 1),
      notes: sites.length
        ? sites
            .map((entry) => `${entry.file} max ${describe(entry.max)}`)
            .join(', ')
        : NO_CLIENT,
    },
    {
      name: 'the database client is created once per module, not per request',
      passed: sites.length > 0 && sites.every((entry) => !entry.insideFunction),
      notes: sites.length
        ? sites
            .map(
              (entry) =>
                `${entry.file} ${entry.insideFunction ? 'inside a function' : 'at module scope'}`
            )
            .join(', ')
        : NO_CLIENT,
    },
    {
      name: 'every Supabase host in the workspace is one CONNECT.md lists',
      passed: unknownHosts.length === 0,
      notes: unknownHosts.length
        ? unknownHosts
            .map((entry) => `${entry.host} in ${entry.file}`)
            .join(', ')
        : `hosts found: ${[...new Set(analysis.hostsInWorkspace.map((entry) => entry.host))].join(', ') || 'none'}`,
    },
    {
      name: 'no connection string is hardcoded in application source',
      passed: analysis.hardcodedDsns.length === 0,
      notes: analysis.hardcodedDsns.length
        ? analysis.hardcodedDsns
            .map((entry) => `${entry.file} carries a literal connection string`)
            .join(', ')
        : 'no connection string literal in application source',
    },
    {
      name: 'migration tooling, if configured, uses the direct connection string',
      passed: migrations.length === 0 ? true : migrationsOnDirect,
      notes: migrations.length
        ? migrations
            .map(
              (dsn) =>
                `${dsn.host}:${dsn.port} (${classifyDsn(dsn)?.label ?? 'not a CONNECT.md endpoint'})`
            )
            .join(', ')
        : 'no migration configuration found',
    },
  ];
}
