import { createClient } from '@supabase/supabase-js';

// The legacy anon key, which the guide says serves the same purpose as a
// publishable key. Low privilege either way, so this is not the flaw.
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);
