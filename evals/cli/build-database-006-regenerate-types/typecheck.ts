import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { CheckResult } from '@supabase-evals/core';
import ts from 'typescript';
import { errorMessage } from '../lib/shell.js';

export const APP_EXPORTS = [
  'listOpenTasks',
  'addTask',
  'completeTask',
  'label',
] as const;

/** One module the app imports that exports `Database`, and what its types got wrong. */
export type TypesModule = {
  path: string;
  problems: string[];
};

export type ProjectAnalysis =
  | {
      ok: true;
      typesModules: TypesModule[];
      diagnostics: string[];
      suppressions: string[];
      missingExports: string[];
      appFiles: string[];
    }
  | { ok: false; notes: string };

const SUPABASE_JS = '@supabase/supabase-js';
export const MAX_LISTED_DIAGNOSTICS = 5;
const SUPPRESSION_DIRECTIVES = [
  '@ts-ignore',
  '@ts-expect-error',
  '@ts-nocheck',
];
const ASSERTION_ESCAPES = new Map<ts.SyntaxKind, string>([
  [ts.SyntaxKind.UnknownKeyword, 'unknown'],
  [ts.SyntaxKind.NeverKeyword, 'never'],
  [ts.SyntaxKind.AnyKeyword, 'any'],
]);
const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
};
const TYPESCRIPT_FILE = /\.tsx?$/;

const STATUS_UNION = "'todo' | 'in_progress' | 'done'";
const EXPECTED_TASKS_SHAPES = {
  Row: `{ due_on: string | null; id: number; inserted_at: string; status: ${STATUS_UNION}; title: string }`,
  Insert: `{ due_on?: string | null; id?: number; inserted_at?: string; status?: ${STATUS_UNION}; title: string }`,
  Update: `{ due_on?: string | null; id?: number; inserted_at?: string; status?: ${STATUS_UNION}; title?: string }`,
};
const PROBE_HEADER = [
  'type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;',
];

const posix = (file: string) => file.split(path.sep).join('/');

function packageDir(entry: string, name: string): string {
  let dir = path.dirname(entry);
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (
      fs.existsSync(manifest) &&
      JSON.parse(fs.readFileSync(manifest, 'utf8')).name === name
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`package root of ${name} not found`);
    dir = parent;
  }
}

/** The host install of `@supabase/supabase-js`, resolved the way `@supabase-evals/core` sees it. */
export function resolveSupabaseJsDir(): string {
  const core = createRequire(import.meta.url).resolve('@supabase-evals/core');
  return packageDir(createRequire(core).resolve(SUPABASE_JS), SUPABASE_JS);
}

function listProjectFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name !== 'node_modules' && !entry.isSymbolicLink())
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return listProjectFiles(full);
      return isSourceFile(entry.name) ? [full] : [];
    })
    .sort();
}

function isSourceFile(fileName: string): boolean {
  return TYPESCRIPT_FILE.test(fileName) && !fileName.endsWith('.d.ts');
}

function loadCompilerOptions(
  root: string,
  supabaseJsDir: string
): ts.CompilerOptions {
  let options = DEFAULT_COMPILER_OPTIONS;
  const configPath = path.join(root, 'tsconfig.json');
  if (fs.existsSync(configPath)) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!config.error && config.config) {
      options = ts.parseJsonConfigFileContent(
        config.config,
        ts.sys,
        root
      ).options;
    }
  }
  return {
    ...options,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    paths: { ...options.paths, [SUPABASE_JS]: [supabaseJsDir] },
  };
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
}

function exportsDatabase(source: ts.SourceFile): boolean {
  return source.statements.some((statement) => {
    if (
      ts.isTypeAliasDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement)
    ) {
      return (
        statement.name.text === 'Database' &&
        (statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
        ) ??
          false)
      );
    }
    return (
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.some(
        (element) => element.name.text === 'Database'
      )
    );
  });
}

function moduleSpecifiers(source: ts.SourceFile): string[] {
  return source.statements.flatMap((statement) =>
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier)
      ? [statement.moduleSpecifier.text]
      : []
  );
}

type Probe = { text: string; labels: Map<number, string> };

function buildProbe(specifier: string): Probe {
  const tasks = "Database['public']['Tables']['tasks']";
  const assertions: [label: string, type: string][] = [
    ...(['Row', 'Insert', 'Update'] as const).map((kind): [string, string] => [
      `tasks ${kind}`,
      `Equals<${tasks}['${kind}'], ${EXPECTED_TASKS_SHAPES[kind]}>`,
    ]),
    [
      'task_status enum',
      `Equals<Database['public']['Enums']['task_status'], ${STATUS_UNION}>`,
    ],
  ];
  const header = [
    `import type { Database } from '${specifier}';`,
    ...PROBE_HEADER,
  ];
  return {
    text: `${[
      ...header,
      ...assertions.map(
        ([, type], index) => `export const check${index}: ${type} = true;`
      ),
    ].join('\n')}\n`,
    labels: new Map(
      assertions.map(([label], index) => [header.length + index + 1, label])
    ),
  };
}

function diagnosticLine(diagnostic: ts.Diagnostic): number | undefined {
  return diagnostic.file && diagnostic.start !== undefined
    ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1
    : undefined;
}

function diagnosticMessage(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
}

function formatDiagnostic(root: string, diagnostic: ts.Diagnostic): string {
  const line = diagnosticLine(diagnostic);
  return diagnostic.file && line !== undefined
    ? `${posix(path.relative(root, diagnostic.file.fileName))}:${line} ${diagnosticMessage(diagnostic)}`
    : diagnosticMessage(diagnostic);
}

type Assertion = ts.AsExpression | ts.TypeAssertion;

function isAssertion(node: ts.Node): node is Assertion {
  return ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);
}

function withoutParentheses(expression: ts.Expression): ts.Expression {
  let inner = expression;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  return inner;
}

function findDirective(
  comment: string
): { kind: string; offset: number } | undefined {
  let offset = 0;
  for (const line of comment.split('\n')) {
    const text = line.replace(/^[\s/*]+/, '');
    const kind = SUPPRESSION_DIRECTIVES.find((directive) =>
      text.startsWith(directive)
    );
    if (kind !== undefined) {
      return { kind, offset: offset + line.length - text.length };
    }
    offset += line.length + 1;
  }
  return undefined;
}

function scanSuppressions(
  relativePath: string,
  source: ts.SourceFile
): string[] {
  const found: { pos: number; line: number; kind: string }[] = [];
  const seenComments = new Set<number>();
  const lineAt = (pos: number) =>
    source.getLineAndCharacterOfPosition(pos).line + 1;
  const visit = (node: ts.Node) => {
    const comments = [
      ...(ts.getLeadingCommentRanges(source.text, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(source.text, node.end) ?? []),
    ];
    for (const comment of comments) {
      if (seenComments.has(comment.pos)) continue;
      seenComments.add(comment.pos);
      const directive = findDirective(
        source.text.slice(comment.pos, comment.end)
      );
      if (directive) {
        const pos = comment.pos + directive.offset;
        found.push({ pos, line: lineAt(pos), kind: directive.kind });
      }
    }
    const start = node.getStart(source);
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      found.push({ pos: start, line: lineAt(start), kind: 'any' });
    }
    if (isAssertion(node)) {
      if (node.type.kind === ts.SyntaxKind.NeverKeyword) {
        found.push({ pos: start, line: lineAt(start), kind: 'as never' });
      }
      const inner = withoutParentheses(node.expression);
      const escape = isAssertion(inner)
        ? ASSERTION_ESCAPES.get(inner.type.kind)
        : undefined;
      if (escape !== undefined) {
        found.push({
          pos: start,
          line: lineAt(start),
          kind:
            ts.isAsExpression(node) && ts.isAsExpression(inner)
              ? `as ${escape} as`
              : `double assertion through ${escape}`,
        });
      }
    }
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return found
    .sort((a, b) => a.pos - b.pos)
    .map(({ line, kind }) => `${relativePath}:${line} ${kind}`);
}

function findCallableExports(
  program: ts.Program,
  files: readonly string[]
): Set<string> {
  const checker = program.getTypeChecker();
  const callable = new Set<string>();
  for (const file of files) {
    const source = program.getSourceFile(file);
    const moduleSymbol = source && checker.getSymbolAtLocation(source);
    if (!moduleSymbol) continue;
    for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
      const target =
        symbol.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(symbol)
          : symbol;
      if (checker.getTypeOfSymbol(target).getCallSignatures().length > 0) {
        callable.add(symbol.name);
      }
    }
  }
  return callable;
}

/**
 * Compiles every `.ts` file under `<root>/src` with the scorer's own compiler options, so the agent's tsconfig and `node_modules` cannot change the verdict.
 */
export function analyseProject(
  root: string,
  options: { supabaseJsDir?: string } = {}
): ProjectAnalysis {
  try {
    if (!fs.existsSync(root)) {
      return { ok: false, notes: `workspace directory ${root} not found` };
    }
    const srcDir = path.join(root, 'src');
    if (!fs.existsSync(srcDir)) {
      return { ok: false, notes: 'no src directory in the workspace' };
    }
    const compilerOptions = loadCompilerOptions(
      root,
      options.supabaseJsDir ?? resolveSupabaseJsDir()
    );
    const files = listProjectFiles(srcDir);
    const relative = (file: string) => posix(path.relative(root, file));
    const parsed = new Map<string, ts.SourceFile>();
    const sourceOf = (file: string) => {
      const source = parsed.get(file) ?? parse(file);
      parsed.set(file, source);
      return source;
    };

    const probeSources = new Map<string, string>();
    const host = ts.createCompilerHost(compilerOptions);
    const { getSourceFile, fileExists, readFile } = host;
    host.getSourceFile = (name, languageVersion, onError, shouldCreate) => {
      const probe = probeSources.get(name);
      return probe === undefined
        ? getSourceFile.call(host, name, languageVersion, onError, shouldCreate)
        : ts.createSourceFile(name, probe, languageVersion);
    };
    host.fileExists = (name) =>
      probeSources.has(name) || fileExists.call(host, name);
    host.readFile = (name) =>
      probeSources.get(name) ?? readFile.call(host, name);

    const typesFiles = new Set<string>();
    for (const file of files) {
      for (const specifier of moduleSpecifiers(sourceOf(file))) {
        const resolved = ts.resolveModuleName(
          specifier,
          file,
          compilerOptions,
          host
        ).resolvedModule?.resolvedFileName;
        if (resolved === undefined) continue;
        const target = path.normalize(resolved);
        const inWorkspace =
          !path.relative(root, target).startsWith('..') &&
          !target.split(path.sep).includes('node_modules');
        if (
          inWorkspace &&
          TYPESCRIPT_FILE.test(target) &&
          fs.existsSync(target) &&
          exportsDatabase(sourceOf(target))
        ) {
          typesFiles.add(target);
        }
      }
    }

    const probes = [...typesFiles].sort().map((file, index) => {
      const probePath = path.join(srcDir, `__scorer_probe_${index}.ts`);
      const specifier = `./${posix(path.relative(srcDir, file)).replace(/\.(?:d\.)?tsx?$/, '')}`;
      const probe = buildProbe(specifier);
      probeSources.set(probePath, probe.text);
      return { file, probePath, labels: probe.labels };
    });

    const program = ts.createProgram(
      [...files, ...probes.map((probe) => probe.probePath)],
      compilerOptions,
      host
    );

    const typesModules = probes.map(({ file, probePath, labels }) => {
      const source = program.getSourceFile(probePath);
      const problems = new Set<string>();
      for (const diagnostic of source
        ? [
            ...program.getSyntacticDiagnostics(source),
            ...program.getSemanticDiagnostics(source),
          ]
        : []) {
        const line = diagnosticLine(diagnostic);
        problems.add(
          (line !== undefined && labels.get(line)) ||
            `probe: ${diagnosticMessage(diagnostic)}`
        );
      }
      return { path: relative(file), problems: [...problems] };
    });

    const diagnostics = [
      ...files.flatMap((file) => {
        const source = program.getSourceFile(file);
        return source
          ? [
              ...program.getSyntacticDiagnostics(source),
              ...program.getSemanticDiagnostics(source),
            ]
          : [];
      }),
      ...[
        ...program.getOptionsDiagnostics(),
        ...program.getGlobalDiagnostics(),
      ].filter((diagnostic) => !diagnostic.file),
    ].map((diagnostic) => formatDiagnostic(root, diagnostic));

    const databaseExporters = new Set(
      files.filter((file) => exportsDatabase(sourceOf(file)))
    );
    const appFiles = files
      .filter((file) => !databaseExporters.has(file))
      .map(relative)
      .sort();
    const suppressions = appFiles.flatMap((file) => {
      const source = program.getSourceFile(path.join(root, file));
      return source ? scanSuppressions(file, source) : [];
    });

    const callable = findCallableExports(program, files);
    const missingExports = APP_EXPORTS.filter((name) => !callable.has(name));

    return {
      ok: true,
      typesModules,
      diagnostics,
      suppressions,
      missingExports,
      appFiles,
    };
  } catch (error) {
    return { ok: false, notes: `analysis failed: ${errorMessage(error)}` };
  }
}

export function checkTypesDescribeSchema(
  analysis: ProjectAnalysis
): CheckResult {
  const name = 'generated types describe the new schema';
  if (!analysis.ok) return { name, passed: false, notes: analysis.notes };
  if (analysis.typesModules.length === 0) {
    return {
      name,
      passed: false,
      notes: 'no app file imports a module that exports Database',
    };
  }
  return {
    name,
    passed: analysis.typesModules.every(
      ({ problems }) => problems.length === 0
    ),
    notes: analysis.typesModules
      .map(
        ({ path, problems }) =>
          `${path}: ${problems.length === 0 ? 'ok' : problems.join(', ')}`
      )
      .join('; '),
  };
}

export function checkAppTypeChecks(analysis: ProjectAnalysis): CheckResult {
  const name = 'app code type-checks against the generated types';
  if (!analysis.ok) return { name, passed: false, notes: analysis.notes };
  const { diagnostics } = analysis;
  return {
    name,
    passed: diagnostics.length === 0,
    notes:
      diagnostics.length === 0
        ? '0 diagnostics'
        : `${diagnostics.length} diagnostics: ${diagnostics.slice(0, MAX_LISTED_DIAGNOSTICS).join('; ')}`,
  };
}

export function checkAppNotSilenced(analysis: ProjectAnalysis): CheckResult {
  const name = 'app code was fixed, not silenced or removed';
  if (!analysis.ok) return { name, passed: false, notes: analysis.notes };
  const findings = [
    ...(analysis.suppressions.length === 0
      ? []
      : [`suppressions: ${analysis.suppressions.join(', ')}`]),
    ...(analysis.missingExports.length === 0
      ? []
      : [`missing exports: ${analysis.missingExports.join(', ')}`]),
  ];
  return {
    name,
    passed: findings.length === 0,
    notes: findings.join('; ') || 'ok',
  };
}
