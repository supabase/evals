import type { ScoreResult, SupabaseClient } from '@supabase-evals/core';

export async function scoreTasks(client: SupabaseClient): Promise<ScoreResult> {
  const { data, error } = await client.from('tasks').select('*');
  if (error)
    return {
      passed: false,
      checks: [
        { name: 'read tasks from Spark', passed: false, notes: error.message },
      ],
    };
  const passed =
    data.length === 3 &&
    data.every(
      (row) =>
        typeof row.title === 'string' &&
        row.created_at != null &&
        typeof row.completed === 'boolean'
    ) &&
    data.filter((row) => !row.completed).length === 2;
  return {
    passed,
    checks: [
      {
        name: 'three tasks, two open',
        passed,
        notes: `Read ${data.length} rows from Spark`,
      },
    ],
  };
}
