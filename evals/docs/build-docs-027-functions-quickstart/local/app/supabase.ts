import { createClient } from '@supabase/supabase-js';

// Points at whichever project the app is run against. Locally that is the stack
// on this machine.
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
);
