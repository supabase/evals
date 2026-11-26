// The help center's side of the search box. It runs with the project's public
// (anon) key, so everything it needs has to be reachable that way.
//
// Saving an article stores the list of numbers `embed()` gives for its body, in
// a column called `embedding` on `articles`. Searching asks the database for
// the closest articles to the visitor's text, closest first, and shows
// whatever comes back; it never trims the list itself.
import { createClient } from '@supabase/supabase-js';
import { embed } from './embed.mjs';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export async function saveArticle(title, body) {
  const { error } = await supabase
    .from('articles')
    .insert({ title, body, embedding: embed(body) });
  if (error) throw error;
}

// Resolves to [{ id, title }, ...], the closest article first.
export async function searchArticles(text, count = 5) {
  const { data, error } = await supabase.rpc('match_articles', {
    query_embedding: embed(text),
    match_count: count,
  });
  if (error) throw error;
  return data;
}
