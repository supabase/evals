// The help center page's side of the articles list. It runs in the visitor's
// browser with the project's public (anon) key, and visitors are not signed in.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Resolves to the published articles, newest first.
export async function listArticles() {
  const { data, error } = await supabase
    .schema('help_center')
    .from('articles')
    .select('id, title, body')
    .order('id', { ascending: false });
  if (error) throw error;
  return data;
}
