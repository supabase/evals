import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

export function connect(url: string, key: string) {
  return createClient<Database>(url, key);
}

export type Client = ReturnType<typeof connect>;
