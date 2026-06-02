import { createClient } from "@supabase/supabase-js";

Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const url = new URL(req.url);
  const userId = url.searchParams.get("user_id");

  const { data, error } = await supabase
    .from("private_notes")
    .select("id,user_id,body,created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ notes: data }), {
    headers: { "content-type": "application/json" },
  });
});
