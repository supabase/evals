import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

export type Client = SupabaseClient<Database>;

export function connect(url: string, key: string): Client {
  return createClient<Database>(url, key);
}
