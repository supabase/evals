// The nightly job that publishes new help center articles. It runs on our
// server with the project's secret key, never in a browser.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

export async function publishArticle(title, body) {
  const { error } = await supabase
    .schema('help_center')
    .from('articles')
    .insert({ title, body, published: true });
  if (error) throw error;
}
