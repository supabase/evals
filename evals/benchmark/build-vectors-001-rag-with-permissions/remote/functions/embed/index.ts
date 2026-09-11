import { createClient } from '@supabase/supabase-js';

const model = new Supabase.ai.Session('gte-small');

// Invoked by the app whenever document sections are added or edited; keeps
// each section's embedding in sync with its content.
Deno.serve(async (req) => {
  const { ids } = await req.json();
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const { data: sections, error } = await supabase
    .from('document_sections')
    .select('id,content')
    .in('id', ids);
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  for (const section of sections) {
    const embedding = await model.run(section.content, {
      mean_pool: true,
      normalize: true,
    });
    await supabase
      .from('document_sections')
      .update({ embedding: JSON.stringify(embedding) })
      .eq('id', section.id);
  }

  return new Response(JSON.stringify({ embedded: sections.length }), {
    headers: { 'content-type': 'application/json' },
  });
});
