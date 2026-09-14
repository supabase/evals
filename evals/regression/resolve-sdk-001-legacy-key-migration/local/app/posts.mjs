import { createClient } from '@supabase/supabase-js';

// Public site: lists published post titles. Runs with the project's public
// (client-side) API key, so RLS applies.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const { data, error } = await supabase
  .from('posts')
  .select('title')
  .order('title');

if (error) {
  console.error(error.message);
  process.exit(1);
}
console.log(JSON.stringify(data.map((post) => post.title)));
