import { createClient } from 'jsr:@supabase/supabase-js@2';

// No elevated key anywhere. The emails were copied into profiles at sign-up,
// so the publishable key is enough to read them back.
const client = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_ANON_KEY')!
);

Deno.serve(async () => {
  const { data, error } = await client
    .from('profiles')
    .select('id, display_name, email');
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  const members = (data ?? []).map((row) => ({
    id: row.id,
    email: row.email ?? '',
    displayName: row.display_name ?? '',
  }));

  return new Response(JSON.stringify({ members }), {
    headers: { 'content-type': 'application/json' },
  });
});
