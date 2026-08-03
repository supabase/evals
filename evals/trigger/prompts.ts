export type Category =
  | 'schema'
  | 'security'
  | 'performance'
  | 'data-ops'
  | 'monitoring'
  | 'general';

export type Prompt = { text: string; category: Category };

// Skill-trigger prompt corpus. Each entry is the prompt body from a canonical
// Supabase eval (see evals/<id>/PROMPT.md), reused here as a realistic user
// message to test whether the agent loads the right skill. Index == golden
// promptIndex. No motivation frontmatter is duplicated here; the canonical
// eval carries the provenance.
export const prompts: Prompt[] = [
  // 0: build-cli-001-bootstrap-app
  {
    text: "We're kicking off a todos app and I want the Supabase side ready for the team\nto build on. Set it up the way we'd run it in development, with schema changes\ntracked as migrations so they can be reviewed and replayed.\n\nFor the first slice we just need a `todos` table. Todos aren't public: anyone\nsigned in can read all of them, but nothing should be writable through the API\nfor now. Add a couple of sample todos so there's something to look at.\n\nBefore you hand it back, make sure the running API actually behaves that way —\nsigned-in users get the todos, signed-out requests get nothing.",
    category: 'general',
  },
  // 1: build-cli-002-declarative-schema
  {
    text: 'Add a description text column to the `products` table in my local Supabase stack',
    category: 'schema',
  },
  // 2: build-cli-003-pg-cron-queue-workflow
  {
    text: 'I want to set up a recurring background workflow on my local Supabase stack.\n\nCan you set up a cron job called `enqueue-tasks` to run every minute and push a task into a queue called `tasks`? Then add a `process-tasks` edge function that reads messages off the `tasks` queue and removes them, so a scheduled worker can keep the backlog drained.',
    category: 'general',
  },
  // 3: build-database-001-migrate-postgres-to-supabase
  {
    text: "I have an existing Postgres database I want to migrate to Supabase. There's a binary dump at `source.dump` in the current directory.\n\nCan you set up a local Supabase project and restore the dump into it?",
    category: 'schema',
  },
  // 4: build-frontend-001-todos-app
  {
    text: "Build the missing Supabase integration for this Vite + React todos app.\n\nThe Supabase project already has a `todos` table with RLS policies:\n\n```sql\ntodos(id uuid, user_id uuid default auth.uid(), body text, done boolean, created_at timestamptz)\n```\n\nThe project files are under `local/`. `local/src/App.tsx` already contains the UI\nmarkup and stable `data-testid`s used by the tests. Keep that UI shape intact\nand hook it up to Supabase.\n\nRequirements:\n\n1. Create a Supabase client using `@supabase/supabase-js`. You may create a\n   helper like `local/src/supabase.ts` or keep the client in `App.tsx`.\n2. Read `import.meta.env.VITE_SUPABASE_URL` and\n   `import.meta.env.VITE_SUPABASE_ANON_KEY`.\n3. The sign-in form signs in with email/password.\n4. After sign-in, load and render only the current user's todos.\n5. The add-todo form inserts a todo for the current user. The table defaults `user_id`\n   from `auth.uid()`, so insert only the todo body.\n6. Checking a todo updates its `done` state in Supabase.\n7. Throw an error if any Supabase call fails.\n\nYou may refactor the implementation, but keep the existing user-facing controls\nand `data-testid` attributes so the tests can drive the app.",
    category: 'general',
  },
  // 5: build-functions-001-order-total
  {
    text: 'Create a Supabase Edge Function named `order-total`.\n\nThe function should accept only `POST` requests with a JSON body:\n\n```json\n{\n  "items": [\n    { "sku": "basic-plan", "unit_price_cents": 1200, "quantity": 2 }\n  ],\n  "customer_tier": "standard",\n  "coupon": "WELCOME10"\n}\n```\n\nImplement this behavior:\n\n1. Return `405` for non-`POST` requests.\n2. Return `400` with a JSON error if the body is invalid JSON, if `items` is\n   missing or empty, or if any item has a non-positive `unit_price_cents` or\n   `quantity`.\n3. Calculate `subtotal_cents` as the sum of `unit_price_cents * quantity`.\n4. Apply the best single discount:\n   - Coupon `WELCOME10`: 10% off subtotal, capped at 2000 cents.\n   - `customer_tier: "enterprise"`: 15% off subtotal.\n   - Discounts do not stack; use whichever discount is larger.\n5. Calculate `tax_cents` as 7.25% of the post-discount amount, rounded to the\n   nearest cent.\n6. Return `200` JSON with `subtotal_cents`, `discount_cents`, `tax_cents`, and\n   `total_cents`.\n\nDeploy the function with slug `order-total`. The deployed source should be a\nsingle `index.ts` file.',
    category: 'general',
  },
  // 6: build-functions-002-edge-auth-db
  {
    text: 'Create a Supabase Edge Function named `todo-create`.\n\nThe function must:\n\n1. Accept only `POST` requests.\n2. Require the caller\'s `Authorization` header and forward it to Supabase.\n3. Use `@supabase/supabase-js` with:\n  - `Deno.env.get("SUPABASE_URL")`\n  - `Deno.env.get("SUPABASE_ANON_KEY")`\n4. Read JSON body `{ "body": "todo text" }`.\n5. Insert one row into the existing `todos` table. The table defaults `user_id`\n  from `auth.uid()`, so insert only the `body` value.\n6. Return `201` JSON containing the inserted row.\n7. Return a non-2xx JSON error for missing auth, invalid JSON, missing body, or\n  insert/select failures.\n\nDeploy the function with slug `todo-create`. The deployed source should be a\nsingle `index.ts` file.',
    category: 'general',
  },
  // 7: build-functions-003-todos-crud-api
  {
    text: 'Create a Supabase Edge Function named `todos-api`.\n\nThe function must use `@supabase/supabase-js` with:\n\n- `Deno.env.get("SUPABASE_URL")`\n- `Deno.env.get("SUPABASE_ANON_KEY")`\n- The caller\'s `Authorization` header forwarded through `global.headers`\n\nImplement these routes:\n\n1. `GET /todos-api`\n  - Requires auth.\n  - Returns the caller\'s todos ordered by `created_at` ascending.\n  - Supports optional `?done=true|false`.\n  - Supports optional `?limit=` from 1 to 100, defaulting to 50.\n2. `POST /todos-api`\n  - Requires auth.\n  - Reads JSON body `{ "body": "todo text", "done": false }`.\n  - `body` is required and must be a non-empty string.\n  - `done` is optional and defaults to `false`.\n  - Returns `201` JSON containing the inserted row.\n3. `PATCH /todos-api/<uuid>`\n  - Requires auth.\n  - Accepts a JSON object with only `body` and/or `done`.\n  - Returns the updated row.\n  - Return `404` if the row does not belong to the caller or does not exist.\n4. `DELETE /todos-api/<uuid>`\n  - Requires auth.\n  - Deletes the caller\'s row and returns JSON `{ "deleted": true }`.\n  - Return `404` if the row does not belong to the caller or does not exist.\n\nReturn JSON errors for missing auth (`401`), unsupported methods (`405`),\ninvalid JSON (`400`), invalid UUID path params (`400`), invalid query params\n(`400`), and database failures.\n\nDeploy the function with slug `todos-api`. The deployed source should be a\nsingle `index.ts` file.',
    category: 'general',
  },
  // 8: build-functions-004-service-role-bypass
  {
    text: "I built an Edge Function called `private-notes` for showing a user's saved\nprivate notes.\n\nCan you check whether there's any way one user could see another user's notes?\n\nPlease fix and deploy it if needed.",
    category: 'security',
  },
  // 9: build-functions-005-dual-auth-user-secret
  {
    text: "Build and serve a Supabase Edge Function named `user-stats` for this project,\nreachable over HTTP at `/functions/v1/user-stats`.\n\nOur product stores per-user metrics in the existing `user_stats` table.\n\nTwo very different callers need to hit this one endpoint:\n\n1. **Our mobile app**, acting for a signed-in user. It sends that user's\n   Supabase access token. The endpoint should return the user's own stats.\n\n2. **Our internal billing service**, a trusted backend with no signed-in user.\n   It authenticates with the project's secret (service-role) key in the `apikey`\n   header, and names the target user with a `user_id` in the JSON request body.\n   It needs that user's stats.\n\nReturn the matching rows as JSON. The endpoint must be secure: only ever serve\nstats to a caller that is genuinely entitled to them, and turn away callers that\nare not.",
    category: 'security',
  },
  // 10: build-functions-006-dual-auth-with-server
  {
    text: "Build and serve a Supabase Edge Function named `user-stats` for this project,\nreachable over HTTP at `/functions/v1/user-stats`.\n\nImplement it with the **`@supabase/server`** package, which is built for exactly\nthis kind of multi-auth Edge Function. Import it directly in your function:\n\n```ts\nimport { withSupabase } from \"npm:@supabase/server\";\n```\n\nOur product stores per-user metrics in a `user_stats` table that already exists\n(see `supabase/migrations/`), protected by row-level security so a user can read\nonly their own rows.\n\nTwo very different callers need to hit this one endpoint:\n\n1. **Our mobile app**, acting for a signed-in user. It sends that user's\n   Supabase access token. The endpoint should return the user's own stats.\n\n2. **Our internal billing service**, a trusted backend with no signed-in user.\n   It authenticates with the project's secret (service-role) key in the `apikey`\n   header, and names the target user with a `user_id` in the JSON request body.\n   It needs that user's stats.\n\nReturn the matching rows as JSON. The endpoint must be secure: only ever serve\nstats to a caller that is genuinely entitled to them, and turn away callers that\nare not.\n\nGet the local stack running so the function is reachable at the path above.",
    category: 'security',
  },
  // 11: build-realtime-001-live-chat-updates
  {
    text: "I'm building a simple chat app on Supabase.\n\nUsers can send messages, and I want everyone in the same room to see new\nmessages appear automatically without refreshing the page.\n\nCan you inspect the project and set up whatever Supabase needs for live updates?",
    category: 'general',
  },
  // 12: build-rls-002-own-todos-client
  {
    text: 'You are working on a Supabase project for a todos app.\n\nThe `todos` table already exists:\n\n```sql\nid uuid, user_id uuid, body text, done boolean, created_at timestamptz\n```\n\n`user_id` defaults to `auth.uid()`, so app code can insert a todo by sending only\n`body` / `done`.\n\nAdd the RLS policies needed so that authenticated users can:\n\n1. `SELECT` only their own todos.\n2. `INSERT` only their own todos.\n3. `UPDATE` only their own todos.\n4. `DELETE` only their own todos.\n\nApply the required database changes. End your turn when you believe the\npolicies are in place.',
    category: 'security',
  },
  // 13: build-rls-003-org-roles-permissions
  {
    text: 'You are working on a Supabase project for a multi-tenant document app.\n\nThe schema has three tables already created and seeded:\n\n```sql\n-- memberships\nuser_id uuid, org_id uuid, role text\n\n-- documents\nid uuid, org_id uuid, owner_id uuid, title text, body text, deleted_at timestamptz\n\n-- document_audit\nid uuid, document_id uuid, actor_id uuid, action text, ts timestamptz\n```\n\nAdd the RLS policies and database logic needed for authenticated users:\n\n1. Viewers can read active documents in orgs where they are members.\n2. Editors can read active documents in their orgs, insert documents they own in their orgs, and update or delete only documents they own.\n3. Admins can read, update, and delete any active document in orgs where they are admins.\n4. Soft-deleted documents (`deleted_at IS NOT NULL`) should not be visible through normal reads.\n5. Deletes should be soft deletes by setting `deleted_at`; do not hard-delete rows.\n6. Every insert, update, and soft-delete should write a row to `document_audit` with the acting user.\n\nApply the required database changes. End your turn when you believe the\npolicies and audit behavior are in place.',
    category: 'security',
  },
  // 14: build-storage-001-private-bucket-access
  {
    text: "Our app lets signed-in users keep personal files like receipts and bank\nstatements. These files are private — a user must only ever be able to upload\nand download their own. The app uploads each file under a path that starts\nwith the owner's user id, e.g. `<user_id>/receipt-march.pdf`.\n\nSet up a `user-files` bucket on our project and lock it down that way.\n\nUsers also sometimes share one of their files with someone else through a\ntemporary link that expires. Include the supabase-js code the app should use\nfor that.",
    category: 'security',
  },
  // 15: build-tests-001-rls-tenant-isolation
  {
    text: 'Can you audit the tenant isolation on our tables? Write some database tests covering both the happy path and the negative case, run them, and share the results.',
    category: 'security',
  },
  // 16: build-vectors-001-rag-with-permissions
  {
    text: "We're adding semantic search to our internal knowledge base app. I already wrote the edge functions, but search doesn't work yet. Can you set up whatever the database needs to make search work end to end?\n\nSome documents are confidential, so users should only have access to documents they own.",
    category: 'schema',
  },
  // 17: deploy-database-001-prometheus-metrics
  {
    text: 'Can you wire my Supabase project metrics into our existing observability stack and document\nin the observability README what we need to do to make the config live?',
    category: 'monitoring',
  },
  // 18: deploy-functions-001-edge-function-secrets
  {
    text: "Our weather widget currently calls WeatherAPI straight from the browser, which\nleaks our API key. I want to move that behind a Supabase Edge Function called\n`weather` that holds the key server-side and proxies the request.\n\nThe function should read the key from an environment variable named\n`WEATHER_API_KEY`. Our key already lives in a local `.env` file at the project\nroot.\n\nDeploy the function to our project so it's live, and make sure the deployed\nfunction can actually read the key at runtime.",
    category: 'general',
  },
  // 19: deploy-self-hosting-001-docker-compose
  {
    text: "I'm moving off the hosted Supabase and running the whole thing myself on a VPS I\njust spun up. Can you get a Docker setup ready for me to copy onto the box?\n\nI don't need it running here, I'll do the actual bring-up once I'm on the\nserver. I just want everything in place and the secrets set up. Put it in a `supabase-docker/`\nfolder at the repo root so I can scp the whole thing across in one go.",
    category: 'general',
  },
  // 20: investigate-auth-001-deleted-user-access
  {
    text: "Last week support removed a user through our app's delete-account flow — the\napp calls the `delete_account` function over RPC as the signed-in user. This\nmorning that same person was back: still signed in, reading and saving their\ndata like nothing happened.\n\nFigure out why the account still works, fix the flow so a deleted account\nloses access, and tell me whether there is any window where they could still\nget in after the fix.\n\nOne more thing while you're at it: we're migrating off the legacy\nanon/service_role API keys to the new publishable and secret keys, and the\nteam isn't sure which one belongs in the frontend and what each means for\nRLS. Give us a quick rundown.",
    category: 'security',
  },
  // 21: investigate-db-001-table-row-counts
  {
    text: 'List every user-defined table in the `public` schema and its exact row count.\n\nReport the results as table name plus count.',
    category: 'schema',
  },
  // 22: investigate-functions-001-546-resource-limit
  {
    text: "Our `video-thumbnails` edge function has been failing intermittently since this morning. It generates a thumbnail from a user-uploaded video, and about half the calls are erroring out.\n\nCan you investigate the project logs and tell me what's going on and what we should do about it?",
    category: 'monitoring',
  },
  // 23: investigate-logs-001-top-error-function
  {
    text: 'Identify the edge function with the most errors in the last 15 minutes.\n\nReport:\n\n- The function id\n- The exact error count\n- The total event count for that function in the same window\n\nUse the available project observability data to answer.',
    category: 'monitoring',
  },
  // 24: investigate-realtime-001-subscribed-no-events
  {
    text: "Our dispatch dashboard shows incoming orders as they happen. The courier\nlocation feed on the same page updates live without problems, but new orders\nonly show up after a page refresh.\n\nThe dashboard uses supabase-js to subscribe to INSERT events on the `orders`\ntable through postgres_changes, the same way it subscribes to courier\nlocations. The channel's status callback logs SUBSCRIBED and there are no\nerrors in the browser console.\n\nFigure out why no order events ever arrive and fix it.",
    category: 'general',
  },
  // 25: investigate-reliability-001-error-rate-spike
  {
    text: 'Audit the recent edge-function logs for any reliability problem worth flagging.\n\nIf you find one, report:\n\n- The affected function id\n- The observed error rate\n- Why the rate is concerning\n- A concrete next step to investigate or mitigate it\n\nBe specific. Vague answers like "review the logs" do not count.',
    category: 'monitoring',
  },
  // 26: investigate-reliability-002-subtle-error-spike
  {
    text: 'Audit recent edge-function logs for any reliability issue worth a human\'s\nattention.\n\nReport the affected function and explain why it is concerning. Be concrete\nabout the window or grouping you used. Vague answers like "some errors are\npresent" do not count.',
    category: 'monitoring',
  },
  // 27: investigate-reliability-003-edge-function-5xx-correlation
  {
    text: 'Users have been reporting that image uploads are intermittently failing with server errors throughout the morning of `2026-04-28`.\n\nCan you investigate the project logs and tell me what is going on and what we\nshould do next?',
    category: 'monitoring',
  },
  // 28: investigate-security-001-public-table
  {
    text: 'You have access to the project\'s database schema and recent logs.\n\nIdentify any tables exposed to the public/anon role without proper Row Level\nSecurity in place. For each issue found, report:\n\n- The table name\n- The role(s) that can access it\n- Why this is a problem\n- A specific fix (SQL preferred)\n\nBe concrete. Vague answers like "consider reviewing your RLS settings" do not\ncount.',
    category: 'security',
  },
  // 29: resolve-dataapi-001-empty-results
  {
    text: 'Our app lets signed-in users save bookmarks and view them on their dashboard. Bookmarks are stored in the `bookmarks` table and are private — a user must only ever see their own. \nUsers also need to be able to save new bookmarks from the app.\n\nI can see the rows when I query the table directly, but the dashboard shows an empty list for every user.\n\nFind out why the Data API returns nothing and fix it.',
    category: 'data-ops',
  },
  // 30: resolve-dataapi-002-secure-default-grants
  {
    text: "Our app lets signed-in users keep a private journal. Entries are stored in the `journal_entries` table. A user should only ever see their own, and they need to be able to create new entries from the app.\n\nI can see the rows when I query the table directly, but the journal page shows an empty list for every signed-in user. New entries don't show up after saving either. Please figure out why and fix it.",
    category: 'data-ops',
  },
  // 31: resolve-dataapi-002-update-zero-rows-affected
  {
    text: "Our app lets signed-in users manage a personal `tasks` list. Users can create tasks and check them off (`is_done`).\n\nCreating a task works fine, and I can see the row in the table. But when a user checks off a task, the app's update call succeeds with no error, yet `is_done` never actually changes, and the API doesn't return the updated row either.\n\nFind out why the update has no effect and fix it.",
    category: 'data-ops',
  },
  // 32: resolve-database-001-migration-history-mismatch
  {
    text: "I'm trying to ship a migration to our hosted project and it's not working. Can you figure out what's wrong and get it deployed?",
    category: 'schema',
  },
  // 33: resolve-performance-001-slow-query-cpu-spike
  {
    text: 'My database CPU keeps spiking and the app gets slow when loading recent events for a user. Can you figure out what query is causing it and make the database change needed to fix it?\n\nEnd your turn with a short summary of what you changed and why.',
    category: 'performance',
  },
  // 34: resolve-reliability-001-unhealthy-project-recovery
  {
    text: 'My Supabase dashboard says my project is unhealthy, and the dashboard is unusable.\n\nWould restart or pause/restore be better?',
    category: 'monitoring',
  },
  // 35: resolve-security-001-rls-cross-user-leak
  {
    text: "Audit the RLS policies on this Supabase project.\n\nIf any policy lets one authenticated user access another user's data, fix it in\nthe database. Do not weaken existing legitimate access.\n\nEnd your turn when you believe the policies are correct.",
    category: 'security',
  },
  // 36: resolve-security-002-rls-cross-tenant-leak
  {
    text: 'A customer reported that notes showed up in the wrong workspace.\n\nCan you investigate what is going on and fix it?',
    category: 'security',
  },
  // 37: resolve-storage-001-upsert-missing-update-policy
  {
    text: "Our app has a public `avatars` bucket so profile photos have a public URL. Each user's avatar is stored at `<user_id>/avatar.png`, and the app uploads it with `upsert: true` so a new photo replaces the old one at that same path.\n\nThe very first upload for a user always works, but replacing an existing avatar fails. Find out why and fix it.",
    category: 'security',
  },
];
