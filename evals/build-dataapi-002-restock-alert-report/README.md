Companion to `build-dataapi-001-relational-report`. Same shape (unnamed SDK,
empty `package.json`, bare backend worker script reading `SUPABASE_URL` /
`SUPABASE_SECRET_KEY` from the env) but a different schema and aggregation
(inventory restock alerts vs. a sales report), to check whether that eval's
SDK-adoption split (claude-code 4/4 vs. codex 0/4) is a real model tendency
or an artifact of that one prompt. Beyond this pair of evals,
supabase/agent-skills#173 documents the same underlying failure shape in the
wild — a Codex session reaching for raw PostgREST credentials and an admin
browser instead of the intended tool for a data task.
