import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  const { name } = await req.json().catch(() => ({ name: "Functions" }));

  return new Response(
    JSON.stringify({
      message: `Hello from ${name}!`,
      worker: "process-tasks",
      ready: Boolean(supabase),
    }),
    {
      headers: { "content-type": "application/json" },
    },
  );
});
