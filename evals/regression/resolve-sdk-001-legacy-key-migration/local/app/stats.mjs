import { createClient } from '@supabase/supabase-js';

// Internal tooling: counts unpublished drafts across all posts. Trusted
// backend only — runs with the project's server-side key, which bypasses RLS.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const { count, error } = await supabase
  .from('posts')
  .select('*', { count: 'exact', head: true })
  .eq('published', false);

if (error) {
  console.error(error.message);
  process.exit(1);
}
console.log(JSON.stringify({ drafts: count }));
