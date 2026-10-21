import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolCallRecord } from '@supabase-evals/core';
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

export const TASKS_IMPLEMENTED_OUTSIDE_SRC = {
  'lib/tasks.ts': STALE_TASKS.replaceAll("from './", "from '../src/"),
  'src/tasks.ts':
    "export { listOpenTasks, addTask, completeTask, label } from '../lib/tasks';\n",
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

export const APPLY_CREATE_TASKS =
  'Applying migration 20260101000000_create_tasks.sql...';
export const APPLY_TASK_STATUS =
  'Applying migration 20260315000000_task_status.sql...';

/** `supabase start` output trimmed to the migration lines and the env JSON. */
export const DOCKER_START_OUTPUT = [
  'Starting database...',
  'Initialising schema...',
  'Seeding globals from roles.sql...',
  APPLY_CREATE_TASKS,
  APPLY_TASK_STATUS,
  'WARN: no files matched pattern: supabase/seed.sql',
  '{"DB_URL":"postgresql://postgres:postgres@127.0.0.1:54322/postgres","API_URL":"http://127.0.0.1:54321","message":""}',
  'A new version of Supabase CLI is available: v2.121.0 (currently installed v2.117.0)',
  '',
].join('\n');

export function codexCall(command: string, result: string): ToolCallRecord {
  const wrapped = command.includes("'")
    ? `/bin/bash -lc "${command}"`
    : `/bin/bash -lc '${command}'`;
  return {
    tool: { kind: 'other', toolName: 'command_execution' },
    body: { command: wrapped },
    name: 'shell',
    command: wrapped,
    cwd: '/tmp/sandbox-6a06bb83',
    result,
    ts: 1792408491147,
    resultTs: 1792408549452,
  };
}

const SILENT_FAILED_COMMAND =
  "/bin/bash -lc 'supabase gen types typescript --local --schema public > /tmp/task-board-types.ts'";

/** A failed `gen types` call recorded with `error: ""` and no result, because its output went into a redirect. */
export const SILENT_FAILED_GEN_TYPES_CALL: ToolCallRecord = {
  tool: { kind: 'other', toolName: 'command_execution' },
  body: { command: SILENT_FAILED_COMMAND },
  name: 'shell',
  command: SILENT_FAILED_COMMAND,
  cwd: '/tmp/sandbox-202cf04a',
  error: '',
  ts: 1792409985161,
  resultTs: 1792409985974,
};

const SILENT_FAILED_TYPECHECK_COMMAND = "/bin/bash -c 'npm run typecheck'";

/** A non-gen-types call recorded with `error: ""` and no result. */
export const SILENT_FAILED_TYPECHECK_CALL: ToolCallRecord = {
  tool: { kind: 'other', toolName: 'command_execution' },
  body: { command: SILENT_FAILED_TYPECHECK_COMMAND },
  name: 'shell',
  command: SILENT_FAILED_TYPECHECK_COMMAND,
  cwd: '/tmp/sandbox-66679d15',
  error: '',
  ts: 1792425381015,
  resultTs: 1792425381174,
};

export function failedCall(command: string, error: string): ToolCallRecord {
  const { result: _result, ...call } = codexCall(command, '');
  return { ...call, error };
}

export const GEN_TYPES_OUTPUT =
  'Connecting to 127.0.0.1 54322\nGenerated TypeScript is unformatted. Format it with:\n  npx oxfmt <generated-file.ts>\n';

/** A `gen types` call that exited zero, its output redirected into the types file. */
export const SUCCEEDED_GEN_TYPES_CALL = codexCall(
  'supabase gen types typescript --local --schema public > src/database.types.ts',
  GEN_TYPES_OUTPUT
);

/** `start`, `migration up` and `gen types` in one call, all of which exited zero. */
export const COMPOUND_GEN_TYPES_CALL = codexCall(
  'supabase start --exclude gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor && supabase migration up --local && supabase gen types --local --schema public > /tmp/task-board.database.types.ts && wc -l /tmp/task-board.database.types.ts',
  [
    'Seeding globals from roles.sql...',
    APPLY_CREATE_TASKS,
    APPLY_TASK_STATUS,
    'no files matched pattern: supabase/seed.sql',
    '{"DB_URL":"postgresql://postgres:postgres@127.0.0.1:54322/postgres","message":""}',
    'Connecting to local database...',
    '{"applied":[],"message":"Migrations applied"}',
    `${GEN_TYPES_OUTPUT}150 /tmp/task-board.database.types.ts`,
    '',
  ].join('\n')
);

/** A `gen types` that failed inside a pipe: the call exited zero while its output holds the CLI's error JSON. */
export const MASKED_PIPE_GEN_TYPES_CALL = codexCall(
  "ls -l /tmp/task-board-database.types.ts && supabase gen types --local --schema public 2>&1 | sed -n '1,80p'",
  '{"_tag":"Error","error":{"code":"ContainerRuntimeNotFoundError","message":"docker: command not found (podman also not found) \u2014 install Docker Desktop or Podman and ensure it is on PATH"}}\n'
);

/** The head of a types file `gen types` generated for the new schema. */
export const GENERATED_TYPES = `export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      tasks: {
        Row: {
          due_on: string | null
          id: number
          inserted_at: string
          status: Database["public"]["Enums"]["task_status"]
          title: string
        }
        Insert: {
          due_on?: string | null
          id?: number
          inserted_at?: string
          status?: Database["public"]["Enums"]["task_status"]
          title: string
        }
        Update: {
          due_on?: string | null
          id?: number
          inserted_at?: string
          status?: Database["public"]["Enums"]["task_status"]
          title?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      task_status: "todo" | "in_progress" | "done"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]
`;

export const CONNECT_LOCAL_DB = 'Connecting to db 5432\n';

/** The error text of a call whose `gen types` succeeded and whose later `npm run typecheck` failed. */
export const CHAINED_TYPECHECK_ERROR = `${CONNECT_LOCAL_DB}(node:1) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 error listeners added to [BoundPool]. MaxListeners is 10. Use emitter.setMaxListeners() to increase limit
(Use \`node --trace-warnings ...\` to show where the warning was created)
A new version of Supabase CLI is available: v2.121.0 (currently installed v2.117.0)
We recommend updating regularly for new features and bug fixes: https://supabase.com/docs/guides/cli/getting-started#updating-the-supabase-cli
${GENERATED_TYPES}
--- old field references ---

--- typecheck ---

> typecheck
> tsc --noEmit

sh: 1: tsc: not found
`;

const CHAINED_COMMAND = String.raw`/bin/bash -lc "supabase gen types typescript --local --schema public > src/database.types.ts && head -150 src/database.types.ts && printf '\\n--- old field references ---\\n' && rg -n \"is_complete\" src || true && printf '\\n--- typecheck ---\\n' && npm run typecheck"`;

/** A `gen types` that wrote the new types, in a call that errored because the `npm run typecheck` after it could not find `tsc`. */
export const CHAINED_TYPECHECK_GEN_TYPES_CALL: ToolCallRecord = {
  ...failedCall('', CHAINED_TYPECHECK_ERROR),
  command: CHAINED_COMMAND,
  body: { command: CHAINED_COMMAND },
};

/** A `gen types --db-url` whose TLS failure went into the redirected file, leaving only the connect line in the errored call's output. */
export const TLS_FAILED_GEN_TYPES_CALL = failedCall(
  `set -euo pipefail
for migration in supabase/migrations/*.sql; do
  echo "Applying $migration"
  PGPASSWORD=typegen-only psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$port" -U postgres -d postgres -f "$migration"
done
supabase gen types typescript --db-url "postgresql://postgres:typegen-only@127.0.0.1:$port/postgres" --schema public > /tmp/task-board.database.types.ts`,
  `Status: Downloaded newer image for postgres:17
127.0.0.1:32768 - accepting connections
Applying supabase/migrations/20260101000000_create_tasks.sql
CREATE TABLE
Applying supabase/migrations/20260315000000_task_status.sql
CREATE TYPE
ALTER TABLE
UPDATE 0
ALTER TABLE
ALTER TABLE
Connecting to 127.0.0.1 32768
`
);

export const THROWAWAY_DB_URL =
  'postgresql://postgres:typegen-only@127.0.0.1:$port/postgres?sslmode=disable';

/** `gen types --db-url` against `url`, redirecting the types into a file. */
export function dbUrlGenTypesCall(
  url: string,
  output = GEN_TYPES_OUTPUT
): ToolCallRecord {
  return codexCall(
    `supabase gen types typescript --db-url "${url}" --schema public > /tmp/task-board.database.types.ts`,
    output
  );
}

/** An agent that applied both migrations with psql into a throwaway Postgres container: two `gen types --db-url` attempts errored, the third succeeded. */
export function throwawayDbToolCalls(): ToolCallRecord[] {
  return [
    failedCall(
      'supabase gen types typescript --db-url "postgresql://postgres:typegen-only@127.0.0.1:$port/postgres" --schema public > /tmp/task-board.database.types.ts',
      'Connecting to 127.0.0.1 32768\n'
    ),
    failedCall(
      'supabase --debug gen types typescript --db-url "postgresql://postgres:typegen-only@127.0.0.1:$port/postgres" --schema public >/tmp/task-board.database.types.ts 2>&1',
      'type generation exit: 1\nConnecting to 127.0.0.1 32769\n{"_tag":"Error","error":{"code":"DbConnectError","message":"failed to connect to postgres: tls error (The server does not support SSL connections)"}}\n'
    ),
    dbUrlGenTypesCall(THROWAWAY_DB_URL),
  ];
}

/** Tool calls of an agent that starts the stack, regenerates the types and stops the stack. */
export function dockerRunToolCalls({
  command = 'supabase start',
  output = DOCKER_START_OUTPUT,
}: { command?: string; output?: string } = {}): ToolCallRecord[] {
  return [
    codexCall(command, output),
    codexCall(
      'supabase gen types typescript --local --schema public > src/database.types.ts',
      'Connecting to db 5432\n'
    ),
    codexCall(
      "supabase gen types typescript --local --schema public > /tmp/task-board.database.types.ts && cmp -s src/database.types.ts /tmp/task-board.database.types.ts && echo 'Generated types match local schema.'; supabase stop",
      'Connecting to db 5432\nGenerated types match local schema.\n{"project_id_filter":"task-board","backup":true,"message":"Stopped supabase local development setup."}\n'
    ),
  ];
}
