import type { CheckResult, ToolScorer } from '@supabase-evals/core';
import { isRecord } from '@supabase-evals/core/json';

type Task = {
  id: number;
  title: string;
  completed: boolean;
  created_at: string;
  due_date?: string | null;
};

function isTask(value: unknown): value is Task {
  return (
    isRecord(value) &&
    typeof value.id === 'number' &&
    typeof value.title === 'string' &&
    typeof value.completed === 'boolean' &&
    typeof value.created_at === 'string' &&
    (value.due_date === undefined ||
      value.due_date === null ||
      typeof value.due_date === 'string')
  );
}

export function checkTasks(value: unknown): CheckResult[] {
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
        tasks.every(
          (task) => task.due_date === (task.id === 2 ? '2026-11-10' : null)
        ),
    },
  ];
}

const scorer: ToolScorer = async (ctx) => {
  const checks: CheckResult[] = [];
  try {
    const { rows: columns } = await ctx.query(
      `select type, "notnull" as not_null from pragma_table_info('tasks') where name = 'due_date'`
    );
    const { data, error } = await ctx.client
      .from('tasks')
      .select('*')
      .order('id');
    if (error) throw new Error(error.message);
    checks.push(
      {
        name: 'Optional date column added',
        passed:
          columns.length === 1 &&
          typeof columns[0]?.type === 'string' &&
          columns[0].type.toLowerCase() === 'date' &&
          columns[0].not_null === 0,
      },
      ...checkTasks(data)
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
      'The response must list exactly these open tasks in this order, including their IDs, titles and due dates: 2, Ship task tracker, 2026-11-10; 1, Write release notes, no due date; 4, Plan next iteration, no due date. Task 3 is complete and must not appear as an open task. Accept equivalent date formatting and descriptions of an absent date.',
  });
  checks.push({ name: 'Open tasks reported in due-date order', ...report });
  return { passed: checks.every((check) => check.passed), checks };
};

export default scorer;
