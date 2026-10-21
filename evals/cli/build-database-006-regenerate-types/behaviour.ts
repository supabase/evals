import fs from 'node:fs';
import { stripIndent } from 'common-tags';

export const BEHAVIOUR_CHECK_NAME =
  'app code keeps its behaviour on the new schema';

type SourceFile = { path: string; source: string };

const LOCAL_SRC = new URL('./local/src/', import.meta.url);
const NEW_MIGRATION = new URL(
  './local/supabase/migrations/20260315000000_task_status.sql',
  import.meta.url
);
const TYPES_FILE = 'database.types.ts';

function formatFiles(heading: string, files: readonly SourceFile[]): string[] {
  return [
    heading,
    '',
    ...files.flatMap(({ path, source }) => [`--- ${path} ---`, source, '']),
  ];
}

/** Judge input with the migration and the full seeded and final sources of the app files. */
export function formatBehaviourJudgeInput(input: {
  migrationSql: string;
  seededFiles: readonly SourceFile[];
  finalFiles: readonly SourceFile[];
}): string {
  return [
    'The migration the app code has to follow:',
    '',
    input.migrationSql,
    '',
    ...formatFiles('Seeded app files (before the run):', input.seededFiles),
    ...formatFiles('Final app files (after the run):', input.finalFiles),
  ].join('\n');
}

export const BEHAVIOUR_RUBRIC = stripIndent`
  The agent was asked to regenerate a task-board project's database types after a new migration and update the TypeScript app code to match. You are given the migration, the app files as they were seeded, and the app files as they are after the run.

  The migration replaces the \`is_complete boolean\` column with a \`status\` enum (\`todo\`, \`in_progress\`, \`done\`) and copies \`is_complete = true\` to \`done\`. The faithful mapping is: is_complete = true means status = 'done', and is_complete = false means status is 'todo' or 'in_progress'.

  Judge each exported function of the seeded app code against its final version. Fail if any function still reads or writes \`is_complete\` (the column no longer exists), or if its observable behaviour changes under the mapping. For example: the open-task list drops in_progress tasks or includes done ones, completing a task writes anything but 'done', a new task is created in a state other than todo, or the label marks an in_progress task as finished or a done task as unfinished.

  Pass richer output that preserves those facts, such as a distinct marker for in_progress tasks. Also pass explicitly setting status 'todo' on insert or leaving the column default, added helpers, and reordered code. Ignore formatting, style and unrelated additions.

  Judge only from the sources shown. If you fail the run, cite the function in your notes.
`;

export function readSeededAppFiles(): SourceFile[] {
  return fs
    .readdirSync(LOCAL_SRC)
    .filter((name) => name.endsWith('.ts') && name !== TYPES_FILE)
    .sort()
    .map((name) => ({
      path: `src/${name}`,
      source: fs.readFileSync(new URL(name, LOCAL_SRC), 'utf8'),
    }));
}

export function readNewMigrationSql(): string {
  return fs.readFileSync(NEW_MIGRATION, 'utf8');
}
