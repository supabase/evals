import { supabase } from './supabase';

// The line at the top of the signup screen. It greets whoever is signing up by
// the name they typed, like "Hello Maria!", and the backend builds that whole
// sentence so every screen words it the same way.
//
// `welcome` is the backend piece the team has not built yet.
export async function greeting(name: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke('welcome', {
    body: { name },
  });
  if (error) throw error;
  return data.message;
}
