import type { CheckResult, ToolScorer } from '@supabase-evals/core';
import { isRecord } from '@supabase-evals/core/json';

type Task = Record<string, unknown> & {
  id: number;
  title: string;
  completed: boolean;
  created_at: string;
};

function isTask(value: unknown): value is Task {
  return (
    isRecord(value) &&
    typeof value.id === 'number' &&
    typeof value.title === 'string' &&
    typeof value.completed === 'boolean' &&
    typeof value.created_at === 'string'
  );
}

export function checkTasks(
  value: unknown,
  dueDateColumns: unknown[]
): CheckResult[] {
  if (!Array.isArray(value) || !value.every(isTask))
    return [
      {
        name: 'Existing task data preserved',
        passed: false,
        notes: 'Unexpected task response shape',
      },
    ];
  const createdAt = [
    '2026-11-01 12:00:00',
    '2026-11-01 12:01:00',
    '2026-11-01 12:02:00',
    '2026-11-01 12:03:00',
  ];
  const tasks = value;
  const titles = [
    'Write release notes',
    'Ship task tracker',
    'Review schema',
    'Plan next iteration',
  ];
  return [
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
    },
    {
      name: 'Requested due date saved and other tasks undated',
      passed:
        tasks.length === titles.length &&
        dueDateColumns.some(
          (column) =>
            typeof column === 'string' &&
            tasks.every(
              (task) => task[column] === (task.id === 2 ? '2026-11-10' : null)
            )
        ),
    },
  ];
}

const scorer: ToolScorer = async (ctx) => {
  const checks: CheckResult[] = [];
  try {
    const { rows: columns } = await ctx.query(
      `select name, type, "notnull" as not_null from pragma_table_info('tasks') where name not in ('id', 'title', 'completed', 'created_at')`
    );
    const { data, error } = await ctx.client
      .from('tasks')
      .select('*')
      .order('id');
    if (error) throw new Error(error.message);
    const dateColumns = columns.filter(
      (column) =>
        typeof column.name === 'string' &&
        typeof column.type === 'string' &&
        column.type.toLowerCase() === 'date' &&
        column.not_null === 0
    );
    checks.push(
      { name: 'Optional date column added', passed: dateColumns.length > 0 },
      ...checkTasks(
        data,
        dateColumns.map((column) => column.name)
      )
    );
  } catch (error) {
    checks.push({
      name: 'Hosted task state readable',
      passed: false,
      notes: error instanceof Error ? error.message : String(error),
    });
  }
  const report = await ctx.judge({
    input: ctx.agentReport ?? '',
    rubric:
      'The response must list exactly these open tasks with their due dates: Ship task tracker, November 10, 2026; Write release notes, no due date; Plan next iteration, no due date. Ship task tracker must appear before the undated tasks. Either order among the undated tasks is valid. Review schema is complete and must not appear as an open task. Task IDs are optional. Accept equivalent date formatting and descriptions of an absent date.',
  });
  checks.push({ name: 'Open tasks reported in due-date order', ...report });
  return { passed: checks.every((check) => check.passed), checks };
};

export default scorer;
