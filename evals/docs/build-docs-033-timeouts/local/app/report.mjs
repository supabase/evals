// The public report page. Visitors are never signed in, so it calls the
// project with the publishable key.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_PUBLISHABLE_KEY
);

export async function showReport() {
  const { data, error } = await supabase.rpc('slow_report');
  if (error) throw error;
  return data;
}
