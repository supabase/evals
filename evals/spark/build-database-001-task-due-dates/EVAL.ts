import type {
  CheckResult,
  ToolScorer,
  ToolScoringContext,
} from '@supabase-evals/core';
import { z } from 'zod';

const tasksSchema = z.array(
  z
    .object({
      id: z.number(),
      title: z.string(),
      completed: z.boolean(),
      created_at: z.string(),
    })
    .catchall(z.unknown())
);

async function readTaskState(ctx: ToolScoringContext) {
  try {
    const { rows: addedColumns } = await ctx.query(
      `select name, type, "notnull" as not_null from pragma_table_info('tasks') where name not in ('id', 'title', 'completed', 'created_at')`
    );
    const { data: rawTasks, error: taskReadError } = await ctx.client
      .from('tasks')
      .select('*')
      .order('id');
    if (taskReadError) throw new Error(taskReadError.message);
    const tasks = tasksSchema.parse(rawTasks);
    const dateColumns = addedColumns.flatMap((column) =>
      typeof column.name === 'string' &&
      typeof column.type === 'string' &&
      column.type.toLowerCase() === 'date' &&
      column.not_null === 0
        ? [column.name]
        : []
    );
    return { tasks, dateColumns, error: undefined };
  } catch (error) {
    return {
      tasks: [],
      dateColumns: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const scorer: ToolScorer = async (ctx) => {
  const { tasks, dateColumns, error } = await readTaskState(ctx);
  const titles = [
    'Write release notes',
    'Ship task tracker',
    'Review schema',
    'Plan next iteration',
  ];
  const createdAt = [
    '2026-11-01 12:00:00',
    '2026-11-01 12:01:00',
    '2026-11-01 12:02:00',
    '2026-11-01 12:03:00',
  ];
  const report = await ctx.judge({
    input: ctx.agentReport ?? '',
    rubric:
      'The response must list exactly these open tasks with their due dates: Ship task tracker, November 10, 2026; Write release notes, no due date; Plan next iteration, no due date. Ship task tracker must appear before the undated tasks. Either order among the undated tasks is valid. Review schema is complete and must not appear as an open task. Task IDs are optional. Accept equivalent date formatting and descriptions of an absent date.',
  });
  const checks: CheckResult[] = [
    {
      name: 'Nullable date column added',
      passed: dateColumns.length > 0,
      notes: error,
    },
    {
      name: 'Existing task data preserved',
      passed:
        tasks.length === titles.length &&
        tasks.every(
          (task, index) =>
            task.id === index + 1 &&
            task.title === titles[index] &&
            task.completed === (task.id === 3) &&
            task.created_at === createdAt[index]
        ),
      notes: error,
    },
    {
      name: 'Requested due date saved and other tasks undated',
      passed:
        tasks.length === titles.length &&
        dateColumns.some((column) =>
          tasks.every(
            (task) => task[column] === (task.id === 2 ? '2026-11-10' : null)
          )
        ),
      notes: error,
    },
    { name: 'Open tasks reported in due-date order', ...report },
  ];
  return { passed: checks.every((check) => check.passed), checks };
};

export default scorer;
