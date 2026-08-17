import { createClient } from '@supabase/supabase-js';

// The roster itself is fetched from the server function, correctly. This is the
// leak: the same elevated key was also handed to the client for a staff-only
// action, through a variable name Vite treats as public.
export const admin = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_SECRET_KEY
);

export async function removeMember(id: string) {
  return admin.auth.admin.deleteUser(id);
}
