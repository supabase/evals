import type { Client } from './supabase';
import type { Tables } from './database.types';

export type Task = Tables<'tasks'>;

export async function listOpenTasks(db: Client): Promise<Task[]> {
  const { data, error } = await db
    .from('tasks')
    .select('*')
    .eq('is_complete', false)
    .order('inserted_at');
  if (error) throw error;
  return data;
}

export async function addTask(db: Client, title: string): Promise<Task> {
  const { data, error } = await db
    .from('tasks')
    .insert({ title, is_complete: false })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function completeTask(db: Client, id: number): Promise<void> {
  const { error } = await db
    .from('tasks')
    .update({ is_complete: true })
    .eq('id', id);
  if (error) throw error;
}

export function label(task: Task): string {
  return `${task.is_complete ? '[x]' : '[ ]'} ${task.title}`;
}
