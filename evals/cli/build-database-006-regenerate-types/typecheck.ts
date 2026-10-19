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
const UNTYPED_CLIENT = 'untyped Supabase client';
const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
};
const TYPESCRIPT_FILE = /\.tsx?$/;
const STRICT_FAMILY = [
  'strictNullChecks',
  'noImplicitAny',
  'strictFunctionTypes',
  'strictBindCallApply',
  'strictPropertyInitialization',
  'strictBuiltinIteratorReturn',
  'noImplicitThis',
  'useUnknownInCatchVariables',
  'alwaysStrict',
] as const;
const CONTROL_PROBLEM =
  'type checker produced no diagnostics for a known-bad control';

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
  const loosened = { ...options };
  for (const key of STRICT_FAMILY) delete loosened[key];
  return {
    ...loosened,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    strict: true,
    noCheck: false,
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

function declaresDatabase(source: ts.SourceFile): boolean {
  const declaration = source.statements.find(
    (
      statement
    ): statement is ts.TypeAliasDeclaration | ts.InterfaceDeclaration =>
      (ts.isTypeAliasDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement)) &&
      statement.name.text === 'Database'
  );
  if (declaration === undefined) return false;
  const exportedInline =
    declaration.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    ) ?? false;
  return (
    exportedInline ||
    source.statements.some(
      (statement) =>
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier === undefined &&
        statement.exportClause !== undefined &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.some(
          (element) => element.name.text === 'Database'
        )
    )
  );
}

function moduleSpecifiers(source: ts.SourceFile): ts.Expression[] {
  return source.statements.flatMap((statement) =>
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
    statement.moduleSpecifier !== undefined
      ? [statement.moduleSpecifier]
      : []
  );
}

function findTypesFiles(
  program: ts.Program,
  appFiles: readonly string[],
  isProjectFile: (file: string) => boolean
): string[] {
  const checker = program.getTypeChecker();
  const seen = new Set<ts.Symbol>();
  const found = new Set<string>();
  for (const file of appFiles) {
    const source = program.getSourceFile(file);
    if (!source) continue;
    for (const specifier of moduleSpecifiers(source)) {
      const moduleSymbol = checker.getSymbolAtLocation(specifier);
      if (!moduleSymbol || seen.has(moduleSymbol)) continue;
      seen.add(moduleSymbol);
      const exported = checker
        .getExportsOfModule(moduleSymbol)
        .find((symbol) => symbol.name === 'Database');
      if (!exported) continue;
      const target =
        exported.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(exported)
          : exported;
      for (const declaration of target.declarations ?? []) {
        const declaring = path.normalize(declaration.getSourceFile().fileName);
        if (isProjectFile(declaring)) found.add(declaring);
      }
    }
  }
  return [...found].sort();
}

type Probe = {
  text: string;
  labels: Map<number, string>;
  controlLine: number;
};

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
      'export const __control: Equals<1, 2> = true;',
    ].join('\n')}\n`,
    labels: new Map(
      assertions.map(([label], index) => [header.length + index + 1, label])
    ),
    controlLine: header.length + assertions.length + 1,
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

function isConstAssertion(assertion: Assertion): boolean {
  return (
    ts.isTypeReferenceNode(assertion.type) &&
    ts.isIdentifier(assertion.type.typeName) &&
    assertion.type.typeName.text === 'const'
  );
}

function refersTo(
  checker: ts.TypeChecker,
  node: ts.Node,
  name: string,
  source: ts.SourceFile
): boolean {
  const symbol = checker.getSymbolAtLocation(node);
  const target =
    symbol && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  return (target?.name ?? node.getText(source)) === name;
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
  source: ts.SourceFile,
  checker: ts.TypeChecker
): string[] {
  const found: { pos: number; line: number; kind: string }[] = [];
  const seenComments = new Set<number>();
  const innerOfNested = new Set<ts.Node>();
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
    const report = (kind: string) =>
      found.push({ pos: start, line: lineAt(start), kind });
    if (node.kind === ts.SyntaxKind.AnyKeyword && !innerOfNested.has(node)) {
      report('any');
    }
    if (isAssertion(node)) {
      const inner = withoutParentheses(node.expression);
      if (
        isAssertion(inner) &&
        !isConstAssertion(node) &&
        !isConstAssertion(inner)
      ) {
        innerOfNested.add(inner);
        innerOfNested.add(inner.type);
        const middle = inner.type.getText(source).replace(/\s+/g, ' ');
        report(
          ts.isAsExpression(node) && ts.isAsExpression(inner)
            ? `as ${middle} as`
            : `double assertion through ${middle}`
        );
      } else if (
        node.type.kind === ts.SyntaxKind.NeverKeyword &&
        !innerOfNested.has(node)
      ) {
        report('as never');
      }
    }
    if (
      ts.isTypeReferenceNode(node) &&
      node.typeArguments === undefined &&
      refersTo(
        checker,
        ts.isQualifiedName(node.typeName) ? node.typeName.right : node.typeName,
        'SupabaseClient',
        source
      )
    ) {
      report(UNTYPED_CLIENT);
    }
    if (
      ts.isCallExpression(node) &&
      node.typeArguments === undefined &&
      refersTo(
        checker,
        ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name
          : node.expression,
        'createClient',
        source
      ) &&
      checker.getContextualType(node) === undefined
    ) {
      report(UNTYPED_CLIENT);
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

/** Compiles every `.ts`/`.tsx` file under `<root>/src`, reading the agent's tsconfig but forcing strict checking on and mapping only `@supabase/supabase-js` to the host install. */
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
    const sourceFiles = new Map<string, ts.SourceFile | undefined>();
    const host = ts.createCompilerHost(compilerOptions);
    const { getSourceFile, fileExists, readFile } = host;
    host.getSourceFile = (name, languageVersion, onError, shouldCreate) => {
      const probe = probeSources.get(name);
      if (probe !== undefined) {
        return ts.createSourceFile(name, probe, languageVersion);
      }
      if (!sourceFiles.has(name)) {
        sourceFiles.set(
          name,
          getSourceFile.call(host, name, languageVersion, onError, shouldCreate)
        );
      }
      return sourceFiles.get(name);
    };
    host.fileExists = (name) =>
      probeSources.has(name) || fileExists.call(host, name);
    host.readFile = (name) =>
      probeSources.get(name) ?? readFile.call(host, name);

    const databaseDeclarers = new Set(
      files.filter((file) => declaresDatabase(sourceOf(file)))
    );
    const appPaths = files.filter((file) => !databaseDeclarers.has(file));
    const discovery = ts.createProgram(files, compilerOptions, host);
    const typesFiles = findTypesFiles(
      discovery,
      appPaths,
      (file) =>
        !path.relative(root, file).startsWith('..') &&
        !file.split(path.sep).includes('node_modules') &&
        TYPESCRIPT_FILE.test(file) &&
        fs.existsSync(file)
    );

    const probes = typesFiles.map((file, index) => {
      const probePath = path.join(srcDir, `__scorer_probe_${index}.ts`);
      const specifier = `./${posix(path.relative(srcDir, file)).replace(/\.(?:d\.)?tsx?$/, '')}`;
      const probe = buildProbe(specifier);
      probeSources.set(probePath, probe.text);
      return { file, probePath, ...probe };
    });

    const program = ts.createProgram(
      [...files, ...probes.map((probe) => probe.probePath)],
      compilerOptions,
      host,
      discovery
    );

    const typesModules = probes.map(
      ({ file, probePath, labels, controlLine }) => {
        const source = program.getSourceFile(probePath);
        const problems = new Set<string>();
        let controlFlagged = false;
        for (const diagnostic of source
          ? [
              ...program.getSyntacticDiagnostics(source),
              ...program.getSemanticDiagnostics(source),
            ]
          : []) {
          const line = diagnosticLine(diagnostic);
          if (line === controlLine) {
            controlFlagged = true;
            continue;
          }
          problems.add(
            (line !== undefined && labels.get(line)) ||
              `probe: ${diagnosticMessage(diagnostic)}`
          );
        }
        if (!controlFlagged) problems.add(CONTROL_PROBLEM);
        return { path: relative(file), problems: [...problems] };
      }
    );

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

    const appFiles = appPaths.map(relative).sort();
    const checker = program.getTypeChecker();
    const suppressions = appFiles.flatMap((file) => {
      const source = program.getSourceFile(path.join(root, file));
      return source ? scanSuppressions(file, source, checker) : [];
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
  if (analysis.appFiles.length === 0) {
    return { name, passed: false, notes: 'no app files to type-check' };
  }
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
