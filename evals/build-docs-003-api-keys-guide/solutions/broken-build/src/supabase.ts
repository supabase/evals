import { createClient } from '@supabase/supabase-js';

// Publishable key. This file is bundled into the browser, so nothing with
// elevated privileges belongs in it.
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
);
