import { createClient } from 'jsr:@supabase/supabase-js@2';

// Runs on the server, so it is the only place the elevated key is reachable.
// The runtime injects it; it is never written down in the repo.
const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

Deno.serve(async () => {
  const { data, error } = await admin.auth.admin.listUsers();
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  const { data: profiles } = await admin
    .from('profiles')
    .select('id, display_name');
  const names = new Map(
    (profiles ?? []).map((row) => [
      row.id as string,
      row.display_name as string,
    ])
  );

  const members = data.users.map((user) => ({
    id: user.id,
    email: user.email ?? '',
    displayName: names.get(user.id) ?? '',
  }));

  return new Response(JSON.stringify({ members }), {
    headers: { 'content-type': 'application/json' },
  });
});
