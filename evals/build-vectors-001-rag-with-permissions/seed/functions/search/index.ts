import { createClient } from "@supabase/supabase-js";

const model = new Supabase.ai.Session("gte-small");

// Semantic search over the signed-in user's documents.
Deno.serve(async (req) => {
  const { query, limit = 5 } = await req.json();
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization")! } } },
  );

  const embedding = await model.run(query, { mean_pool: true, normalize: true });

  const { data: sections, error } = await supabase.rpc<{ id: number; content: string }[]>(
    "match_document_sections",
    { query_embedding: JSON.stringify(embedding), match_count: limit },
  );
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ sections }), {
    headers: { "content-type": "application/json" },
  });
});
