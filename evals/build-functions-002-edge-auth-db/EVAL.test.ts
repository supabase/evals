import { expect, test } from 'vitest';
import {
  checksMessage,
  deployFunction,
  scorerCtx,
  seedPath,
  withBackend,
} from '../../apps/framework/harness/scorer-test-kit.js';
import scorer from './EVAL.js';

const EVAL_DIR = 'evals/build-functions-002-edge-auth-db';

const TODO_CREATE_SOURCE = `
import { createClient } from "@supabase/supabase-js";

Deno.serve(async (req) => {
  const json = (payload, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });

  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const authorization = req.headers.get("authorization");
  if (!authorization) return json({ error: "missing authorization" }, 401);

  let body;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  if (typeof body.body !== "string" || body.body.trim() === "") return json({ error: "body is required" }, 400);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL"),
    Deno.env.get("SUPABASE_ANON_KEY"),
    { global: { headers: { Authorization: authorization } } }
  );

  const { data, error } = await supabase
    .from("todos")
    .insert({ body: body.body })
    .select("id,body,user_id")
    .single();

  if (error) return json({ error: error.message }, 400);
  return json(data, 201);
});
`;

test('passes for a JWT-verifying function that inserts as the caller', async () => {
  await withBackend(
    { projectSeedSql: seedPath(EVAL_DIR, 'project.sql') },
    async (backend) => {
      await deployFunction(backend, 'todo-create', TODO_CREATE_SOURCE, {
        verifyJwt: true,
      });

      const result = await scorer(scorerCtx(backend));
      expect(result.passed, checksMessage(result)).toBe(true);
    }
  );
});
