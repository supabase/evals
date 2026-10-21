import { supabase } from './supabase';

export type Task = {
  id: number;
  title: string;
  done: boolean;
  due_date: string | null;
  created_at: string;
};

export async function listTasks(): Promise<Task[]> {
  const { data, error } = await supabase
    .from('tasks')
    .select('id, title, done, due_date, created_at')
    .order('due_date', { ascending: true, nullsFirst: false });
  if (error) throw error;
  return data;
}

export async function setDueDate(id: number, dueDate: string): Promise<void> {
  const { error } = await supabase
    .from('tasks')
    .update({ due_date: dueDate })
    .eq('id', id);
  if (error) throw error;
}

export async function clearDueDate(id: number): Promise<void> {
  const { error } = await supabase
    .from('tasks')
    .update({ due_date: null })
    .eq('id', id);
  if (error) throw error;
}
