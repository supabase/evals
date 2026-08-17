import { createClient } from '@supabase/supabase-js';

// The flaw: an elevated key, written into a file that Vite bundles for the
// browser. The roster screen works, and every row of every table is now one
// devtools tab away.
export const admin = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
);
