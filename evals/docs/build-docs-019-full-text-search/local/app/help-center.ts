// The search box on the help center page.
//
// Whatever a visitor types goes to the database as it is, with no cleaning up:
// "refund", "How do I move my booking?", "  life   jackets ". The database
// answers with the matching articles, and the page lists them top to bottom in
// the order they come back, showing `title` and a snippet of the text. It
// doesn't reorder anything, so the first row is what visitors see first.
//
// `search_articles` doesn't exist in the database yet. It takes `term` and
// returns the articles as rows with `id` and `title`.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_ANON_KEY ?? ''
);

export async function searchArticles(term: string) {
  const { data, error } = await supabase.rpc('search_articles', { term });
  if (error) throw error;
  return data;
}
