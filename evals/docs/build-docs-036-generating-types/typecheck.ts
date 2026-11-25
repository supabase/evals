import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import { listSources } from './files.js';

const SUPABASE_JS = '@supabase/supabase-js';
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
const SUPPRESSION =
  /(?:\/\/\/?|\/\*+|^\s*\*)\s*@ts-(?:nocheck|ignore|expect-error)\b/;

export const PROBE = {
  books: 'catalog.books Row',
  searchArgs: 'catalog.search_books Args',
  searchReturns: 'catalog.search_books Returns',
  ordersRow: 'public.orders Row',
  ordersInsert: 'public.orders Insert',
} as const;
const IMPORT = 'the Database type the client is created with';
const CONTROLS = ['checker control', 'wrong shape control'];

export type Analysis =
  | {
      ok: true;
      appDiagnostics: string[];
      suppressions: string[];
      failedProbes: string[];
      controlFired: boolean;
      booksRowMatches: boolean;
    }
  | { ok: false; reason: string };

type ClientSite = { file: string; imports: string[]; database: string };

type Probe = {
  path: string;
  text: string;
  labels: Map<number, string>;
  controlLines: number[];
};

const readDir = (path: string) => readdirSync(path, { withFileTypes: true });

export function analyze(
  hostWorkspace: string,
  overlay: Record<string, string> = {},
  extraColumn?: string
): Analysis {
  let root: string | undefined;
  try {
    root = stage(hostWorkspace, overlay);
    return typecheck(root, extraColumn);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: message.slice(0, 300) };
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
}

function stage(hostWorkspace: string, overlay: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'generating-types-'));
  const configs = readDir(hostWorkspace)
    .filter((entry) => entry.isFile() && /^tsconfig.*\.json$/.test(entry.name))
    .map((entry) => entry.name);
  for (const file of [...listSources(hostWorkspace, readDir), ...configs]) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(hostWorkspace, file), target);
  }
  for (const [file, content] of Object.entries(overlay)) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const modules = join(hostWorkspace, 'node_modules');
  if (existsSync(modules)) {
    symlinkSync(modules, join(root, 'node_modules'), 'dir');
  }
  return root;
}

function typecheck(root: string, extraColumn?: string): Analysis {
  const appFiles = listSources(root, readDir)
    .filter((file) => file.startsWith('src/'))
    .map((file) => join(root, file));
  const sites = appFiles.flatMap((file) => clientSites(file));
  if (sites.length === 0) {
    return {
      ok: false,
      reason: 'no file under src/ calls createClient with a database type',
    };
  }

  const probes = sites.map((site, index) =>
    buildProbe(site, index, extraColumn)
  );
  for (const probe of probes) writeFileSync(probe.path, probe.text);
  const probeByFile = new Map(
    probes.map((probe) => [toPosix(probe.path), probe])
  );

  const program = ts.createProgram(
    [...appFiles, ...probes.map((probe) => probe.path)],
    compilerOptions(root)
  );

  const appDiagnostics: string[] = [];
  const firedLines = new Map<Probe, Set<number>>(
    probes.map((probe) => [probe, new Set<number>()])
  );
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    const text = ts
      .flattenDiagnosticMessageText(diagnostic.messageText, ' ')
      .slice(0, 160);
    if (!diagnostic.file) {
      appDiagnostics.push(text);
      continue;
    }
    const line = diagnostic.file.getLineAndCharacterOfPosition(
      diagnostic.start ?? 0
    ).line;
    const probe = probeByFile.get(toPosix(diagnostic.file.fileName));
    if (probe) {
      firedLines.get(probe)?.add(line);
    } else {
      appDiagnostics.push(
        `${relative(root, diagnostic.file.fileName)}:${line + 1} ${text}`
      );
    }
  }

  const failed = new Set<string>();
  let controlFired = true;
  for (const probe of probes) {
    const lines = firedLines.get(probe) ?? new Set<number>();
    for (const line of lines) {
      const label = probe.labels.get(line);
      if (label && !CONTROLS.includes(label)) failed.add(label);
    }
    controlFired &&= probe.controlLines.every((line) => lines.has(line));
  }
  const failedProbes = [...failed];

  return {
    ok: true,
    appDiagnostics,
    suppressions: findSuppressions(program, root, probeByFile),
    failedProbes,
    controlFired,
    booksRowMatches:
      controlFired && !failed.has(PROBE.books) && !failed.has(IMPORT),
  };
}

function clientSites(file: string): ClientSite[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const imports = source.statements
    .filter((statement) => ts.isImportDeclaration(statement))
    .map((statement) => statement.getText(source));
  const sites: ClientSite[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      calleeName(node.expression) === 'createClient' &&
      node.typeArguments?.[0]
    ) {
      sites.push({
        file,
        imports,
        database: node.typeArguments[0].getText(source),
      });
    }
    ts.forEachChild(node, (child) => visit(child));
  };
  visit(source);
  return sites;
}

function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function findSuppressions(
  program: ts.Program,
  root: string,
  probes: Map<string, Probe>
): string[] {
  const rootPrefix = `${toPosix(root)}/`;
  return program.getSourceFiles().flatMap((source) => {
    const name = toPosix(source.fileName);
    if (
      !name.startsWith(rootPrefix) ||
      name.includes('/node_modules/') ||
      probes.has(name)
    ) {
      return [];
    }
    return source.text
      .split('\n')
      .flatMap((line, index) =>
        SUPPRESSION.test(line)
          ? [`${relative(root, source.fileName)}:${index + 1}`]
          : []
      );
  });
}

function compilerOptions(root: string): ts.CompilerOptions {
  let options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022 };
  const configPath = join(root, 'tsconfig.json');
  if (existsSync(configPath)) {
    const config = ts.readConfigFile(configPath, (path) =>
      ts.sys.readFile(path)
    );
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
    noUnusedLocals: false,
    noUnusedParameters: false,
    skipLibCheck: true,
    paths: { ...options.paths, [SUPABASE_JS]: [supabaseJsDir()] },
  };
}

function supabaseJsDir(): string {
  const entry = createRequire(import.meta.url).resolve(SUPABASE_JS);
  let dir = dirname(entry);
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (
      existsSync(manifest) &&
      JSON.parse(readFileSync(manifest, 'utf8')).name === SUPABASE_JS
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`${SUPABASE_JS} is not installed`);
    dir = parent;
  }
}

function buildProbe(
  site: ClientSite,
  index: number,
  extraColumn?: string
): Probe {
  const extra = extraColumn ? ` ${extraColumn}: string | null;` : '';
  const db = 'ProbeDatabase';
  const rows: [label: string, line: string][] = [
    ...site.imports.map((line): [string, string] => [
      IMPORT,
      line.replace(/\s*\n\s*/g, ' '),
    ]),
    [IMPORT, `type ${db} = ${site.database.replace(/\s*\n\s*/g, ' ')};`],
    [
      '',
      'type ProbeEquals<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;',
    ],
    ['', 'type ProbeSimplify<T> = { [K in keyof T]: T[K] };'],
    [
      '',
      `type ProbeBook = { id: number; title: string; author: string; price_cents: number; format: 'paperback' | 'hardcover' | 'ebook'; blurb: string | null;${extra} };`,
    ],
    [
      '',
      'type ProbeOrder = { id: number; book_id: number; quantity: number; gift_note: string | null; placed_at: string };',
    ],
    [
      '',
      'type ProbeOrderInsert = { id?: never; book_id: number; quantity?: number; gift_note?: string | null; placed_at?: string };',
    ],
    [
      PROBE.books,
      `export const booksRow: ProbeEquals<ProbeSimplify<${db}['catalog']['Tables']['books']['Row']>, ProbeBook> = true;`,
    ],
    [
      PROBE.searchArgs,
      `export const searchArgs: ProbeEquals<ProbeSimplify<${db}['catalog']['Functions']['search_books']['Args']>, { term: string }> = true;`,
    ],
    [
      PROBE.searchReturns,
      `export const searchReturns: ProbeEquals<ProbeSimplify<${db}['catalog']['Functions']['search_books']['Returns'][number]>, ProbeBook> = true;`,
    ],
    [
      PROBE.ordersRow,
      `export const ordersRow: ProbeEquals<ProbeSimplify<${db}['public']['Tables']['orders']['Row']>, ProbeOrder> = true;`,
    ],
    [
      PROBE.ordersInsert,
      `export const ordersInsert: ProbeEquals<ProbeSimplify<${db}['public']['Tables']['orders']['Insert']>, ProbeOrderInsert> = true;`,
    ],
    [CONTROLS[0], 'export const checker: ProbeEquals<1, 2> = true;'],
    [
      CONTROLS[1],
      `export const wrongShape: ProbeEquals<ProbeSimplify<${db}['catalog']['Tables']['books']['Row']>, { id: string }> = true;`,
    ],
  ];
  const labels = new Map<number, string>();
  rows.forEach(([label], line) => {
    if (label) labels.set(line, label);
  });
  return {
    path: join(dirname(site.file), `scorer-types-probe-${index}.ts`),
    text: `${rows.map(([, line]) => line).join('\n')}\n`,
    labels,
    controlLines: CONTROLS.map((control) =>
      rows.findIndex(([label]) => label === control)
    ),
  };
}

function toPosix(path: string): string {
  return path.split('\\').join('/');
}
