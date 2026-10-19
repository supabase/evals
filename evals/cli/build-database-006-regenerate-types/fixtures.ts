import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectAnalysis } from './typecheck.js';

const LOCAL_DIR = fileURLToPath(new URL('./local', import.meta.url));

export function readLocal(relativePath: string): string {
  return fs.readFileSync(path.join(LOCAL_DIR, relativePath), 'utf8');
}

export const SEEDED_TYPES = readLocal('src/database.types.ts');
export const STALE_TASKS = readLocal('src/tasks.ts');
export const SEEDED_SUPABASE = readLocal('src/supabase.ts');

export function replaceOnce(
  source: string,
  pattern: string | RegExp,
  replacement: string
): string {
  const found =
    typeof pattern === 'string'
      ? source.includes(pattern)
      : pattern.test(source);
  if (!found) throw new Error(`fixture drift: ${String(pattern)} not found`);
  return source.replace(pattern, () => replacement);
}

const workspaces: string[] = [];

/** A copy of the seeded project in a fresh temp dir; a `null` override deletes the path. */
export function makeWorkspace(
  overrides: Record<string, string | null> = {}
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-006-'));
  workspaces.push(dir);
  fs.cpSync(LOCAL_DIR, dir, { recursive: true });
  for (const [file, content] of Object.entries(overrides)) {
    const target = path.join(dir, file);
    if (content === null) {
      fs.rmSync(target, { recursive: true, force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

export function removeWorkspaces(): void {
  for (const dir of workspaces.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const STATUS_ENUM = "Database['public']['Enums']['task_status']";

export type TypesOptions = {
  /** Type of `status` in Row, Insert and Update; defaults to the enum reference. */
  statusType?: string;
  /** Extra Row members, one per entry, e.g. `is_complete: boolean;`. */
  rowExtra?: string[];
  insertStatusRequired?: boolean;
  /** Columns dropped from Insert, e.g. `due_on`. */
  insertOmit?: string[];
  /** Columns dropped from Update, e.g. `status`. */
  updateOmit?: string[];
  /** Extra Update members, one per entry, e.g. `is_complete?: boolean;`. */
  updateExtra?: string[];
  /** Members of `Enums.task_status`. */
  enumValues?: string[];
  /** Type written for `Enums.task_status` instead of the union of `enumValues`. */
  enumType?: string;
};

function tasksBlock(options: TypesOptions): string {
  const status = options.statusType ?? STATUS_ENUM;
  const row = [
    'due_on: string | null;',
    'id: number;',
    'inserted_at: string;',
    `status: ${status};`,
    'title: string;',
    ...(options.rowExtra ?? []),
  ];
  const without = (lines: string[], omitted: string[] = []) =>
    lines.filter((line) => !omitted.some((column) => line.startsWith(column)));
  const insert = without(
    [
      'due_on?: string | null;',
      'id?: number;',
      'inserted_at?: string;',
      `status${options.insertStatusRequired ? '' : '?'}: ${status};`,
      'title: string;',
    ],
    options.insertOmit
  );
  const update = [
    ...without(
      [
        'due_on?: string | null;',
        'id?: number;',
        'inserted_at?: string;',
        `status?: ${status};`,
        'title?: string;',
      ],
      options.updateOmit
    ),
    ...(options.updateExtra ?? []),
  ];
  const members = (lines: string[]) =>
    lines.map((line) => `          ${line}`).join('\n');
  return [
    '      tasks: {',
    `        Row: {\n${members(row)}\n        };`,
    `        Insert: {\n${members(insert)}\n        };`,
    `        Update: {\n${members(update)}\n        };`,
    '        Relationships: [];',
    '      };',
  ].join('\n');
}

/** The seeded types with `public.tasks` and `public.Enums` regenerated for the new migration. */
export function regeneratedTypes(options: TypesOptions = {}): string {
  const values = options.enumValues ?? ['todo', 'in_progress', 'done'];
  const quoted = values.map((value) => `'${value}'`);
  const withTasks = replaceOnce(
    SEEDED_TYPES,
    / {6}tasks: \{[\s\S]*?Relationships: \[\];\n {6}\};/,
    tasksBlock(options)
  );
  const publicAt = withTasks.indexOf('\n  public: {');
  const withEnum =
    withTasks.slice(0, publicAt) +
    replaceOnce(
      withTasks.slice(publicAt),
      '    Enums: {\n      [_ in never]: never;\n    };',
      `    Enums: {\n      task_status: ${options.enumType ?? quoted.join(' | ')};\n    };`
    );
  return replaceOnce(
    withEnum,
    '  public: {\n    Enums: {},\n  },',
    `  public: {\n    Enums: {\n      task_status: [${quoted.join(', ')}],\n    },\n  },`
  );
}

/** Regenerated types as the CLI emits them: double quotes, no semicolons, no graphql_public, no Constants. */
export function rawCliTypes(): string {
  const withoutGraphql = replaceOnce(
    regeneratedTypes(),
    /  graphql_public: \{[\s\S]*?\n {2}\};\n(?= {2}public: \{)/,
    ''
  );
  const withoutConstants = withoutGraphql.slice(
    0,
    withoutGraphql.indexOf('export const Constants')
  );
  return withoutConstants.replaceAll("'", '"').replace(/;$/gm, '');
}

const LIST_STALE = ".eq('is_complete', false)";
const LIST_FIXED = ".neq('status', 'done')";
export const ADD_STALE = '.insert({ title, is_complete: false })';
const ADD_FIXED = '.insert({ title })';
const COMPLETE_STALE = '.update({ is_complete: true })';
const COMPLETE_FIXED = ".update({ status: 'done' })";
export const LABEL_STALE =
  "return `${task.is_complete ? '[x]' : '[ ]'} ${task.title}`;";
export const LABEL_FIXED =
  "return `${task.status === 'done' ? '[x]' : '[ ]'} ${task.title}`;";

export type AppFix = 'list' | 'add' | 'complete' | 'label';

const FIXES: Record<AppFix, [string, string]> = {
  list: [LIST_STALE, LIST_FIXED],
  add: [ADD_STALE, ADD_FIXED],
  complete: [COMPLETE_STALE, COMPLETE_FIXED],
  label: [LABEL_STALE, LABEL_FIXED],
};

/** The seeded `src/tasks.ts` with every stale `is_complete` usage rewritten, except the fixes listed in `skip`. */
export function fixedTasks(skip: AppFix[] = []): string {
  return (Object.keys(FIXES) as AppFix[])
    .filter((fix) => !skip.includes(fix))
    .reduce(
      (source, fix) => replaceOnce(source, FIXES[fix][0], FIXES[fix][1]),
      STALE_TASKS
    );
}

/** `source` with the exported function `name` (declaration through its closing brace) removed. */
export function withoutFunction(source: string, name: string): string {
  return replaceOnce(
    source,
    new RegExp(`export (?:async )?function ${name}\\b[\\s\\S]*?\\n\\}\\n\\n?`),
    ''
  );
}

export function lineOf(source: string, needle: string): number {
  const index = source.split('\n').findIndex((line) => line.includes(needle));
  if (index === -1) throw new Error(`fixture drift: ${needle} not found`);
  return index + 1;
}

/** A workspace with regenerated types and a correctly fixed `src/tasks.ts`, plus `overrides`. */
export function regeneratedWorkspace(
  overrides: Record<string, string | null> = {}
): string {
  return makeWorkspace({
    'src/database.types.ts': regeneratedTypes(),
    'src/tasks.ts': fixedTasks(),
    ...overrides,
  });
}

export const STALE_QUERIES_IN_DECLARER = {
  'src/supabase.ts': `import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database as Generated, Tables } from './database.types';

export type Database = Generated;
export type Client = SupabaseClient<Database>;
type Task = Tables<'tasks'>;

export function connect(url: string, key: string): Client {
  return createClient<Database>(url, key);
}

export async function listOpenTasks(db: Client): Promise<Task[]> {
  // @ts-ignore
  const { data, error } = await db.from('tasks').select('*').eq('is_complete', false);
  if (error) throw error;
  return data;
}

export async function addTask(db: Client, title: string): Promise<void> {
  const { error } = await db.from('tasks').insert({ title });
  if (error) throw error;
}

export async function completeTask(db: Client, id: number): Promise<void> {
  // @ts-ignore
  const { error } = await db.from('tasks').update({ is_complete: true }).eq('id', id);
  if (error) throw error;
}

export function label(task: Task): string {
  // @ts-ignore
  return \`\${task.is_complete ? '[x]' : '[ ]'} \${task.title}\`;
}
`,
  'src/tasks.ts':
    "export { listOpenTasks, addTask, completeTask, label } from './supabase';\n",
};

export const ANY_CLIENT_IN_TYPES_ONLY_DECLARER = {
  'src/db.ts': `import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database as Generated } from './database.types';

export type Database = Generated;
export type Client = SupabaseClient<any>;
`,
  'src/supabase.ts': `import { createClient } from '@supabase/supabase-js';
import type { Client, Database } from './db';

export type { Client };

export function connect(url: string, key: string): Client {
  return createClient<Database>(url, key);
}
`,
  'src/tasks.ts': fixedTasks(['list', 'add', 'complete']),
};

export const DECLARER_ALIAS_WITH_CONNECT = {
  'src/supabase.ts': `import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database as Generated } from './database.types';

export type Database = Generated;
export type Client = SupabaseClient<Database>;

export function connect(url: string, key: string): Client {
  return createClient<Database>(url, key);
}
`,
};

export const CLEAN_TYPES_MODULE = {
  path: 'src/types/supabase.ts',
  problems: [],
};

/** A successful analysis with no findings, plus `overrides`. */
export function analysisFixture(
  overrides: Partial<Extract<ProjectAnalysis, { ok: true }>> = {}
): Extract<ProjectAnalysis, { ok: true }> {
  return {
    ok: true,
    typesModules: [CLEAN_TYPES_MODULE],
    diagnostics: [],
    suppressions: [],
    missingExports: [],
    appFiles: ['src/supabase.ts', 'src/tasks.ts'],
    ...overrides,
  };
}
