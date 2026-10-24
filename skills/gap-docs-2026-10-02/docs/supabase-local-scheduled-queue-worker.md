# Build a local scheduled queue worker

Use this guide when a local Supabase project needs PostgreSQL to enqueue recurring work and an Edge Function to drain a queue. The example creates a durable queue, inserts one JSON task every minute, and exposes a protected function that removes messages using PGMQ's `pop` operation.

## Prerequisites

- A Supabase project directory with `supabase/config.toml`, the Supabase CLI, Docker or a compatible runtime, and `psql`.
- A running local stack (`supabase start`) and access to its database connection details (for example, from `supabase status`).
- The database has the `pgmq` and `pg_cron` extensions available and enabled. Confirm this before writing the workflow migration; enable extensions using the project's established migration/configuration process if needed.
- The local Edge Runtime is available. A server-side API key with elevated queue permissions is available locally; never put that key in browser code or commit it.

Supabase Queues uses the `pgmq` extension. The `pgmq_public` schema provides Data API wrappers for message operations, while queue creation is performed through `pgmq` in SQL. A local CLI project only needs `pgmq_public` in the `[api].schemas` list when a consumer will call the wrapper over PostgREST. An Edge Function can call it with a server-side Supabase client.

## Create the queue and recurring enqueue job

Create a migration with the CLI:

```sh
supabase migration new enqueue_example_tasks
```

Adapt this SQL to the queue name, schedule, and payload your application needs:

```sql
do $$
begin
  if not exists (
    select 1 from pgmq.list_queues() where queue_name = 'tasks'
  ) then
    perform pgmq.create('tasks');
  end if;
end
$$;

select cron.schedule(
  'enqueue-tasks',
  '* * * * *',
  $$select pgmq.send(
    'tasks',
    jsonb_build_object('enqueued_at', now(), 'kind', 'example')
  );$$
);
```

The named `cron.schedule` form replaces the existing job with the same name, so inspect that job before choosing its name in a shared database. The one-minute cron expression runs once per minute. The payload above is only an adaptable example; replace it with the task data your consumer expects.

Apply the migration using the project's normal local workflow:

```sh
supabase migration up --local
```

If the CLI refuses because local migration history contains a version whose migration file is absent, do not infer that the workflow migration was applied or follow a suggested history repair blindly. Inspect `supabase migration list --local`, the actual queue and cron state, and the migration tracking state first. Restore the missing migration file or reconcile history only after establishing the database's actual schema state. If a reviewed multi-statement SQL file must be applied directly to the local database because a CLI query wrapper rejects multiple commands, use `psql` against the local database URL shown by the CLI, with `-v ON_ERROR_STOP=1 -f path/to/migration.sql`; then independently check both schema state and migration history. Direct SQL execution does not record the migration as applied.

## Add the Edge Function

Create a function named for its task, for example:

```sh
supabase functions new process-tasks
```

Configure that function to perform its own bearer-key check before allowing this privileged operation. In `supabase/config.toml`, the adaptable function section is:

```toml
[functions.process-tasks]
verify_jwt = false
```

Because the function performs its own check, disabling gateway JWT verification does not make the queue operation public. Reject requests unless the bearer token matches the server-side key configured for the function. Current local runtimes expose secret keys in `SUPABASE_SECRET_KEYS` as a JSON object; a project using the legacy key environment can use `SUPABASE_SERVICE_ROLE_KEY`. Choose the key your project actually provides, keep it server-side, and do not log or return it.

Example function skeleton (adapt error handling and per-request limits). It uses `pop`, which removes a message as it is read:

```ts
import { createClient } from "npm:@supabase/supabase-js@2";

function getWorkerKey(): string | undefined {
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    const keys = JSON.parse(secretKeys) as Record<string, string>;
    if (keys.default) return keys.default;
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const workerKey = getWorkerKey();
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\\s+/i, "");
  if (!workerKey || bearer !== workerKey) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const client = createClient(Deno.env.get("SUPABASE_URL")!, workerKey);
  let removed = 0;

  try {
    const maxMessages = 25; // Adapt to task duration and request limits.
    for (let index = 0; index < maxMessages; index++) {
      const { data, error } = await client.schema("pgmq_public").rpc("pop", {
        queue_name: "tasks",
      });
      if (error) throw error;
      if (!data || data.length === 0) break;

      // Process data[0].message here. This example consumes and removes it.
      removed++;
    }
    return Response.json({ removed });
  } catch (error) {
    console.error("Queue worker failed", error);
    return Response.json({ error: "Queue processing failed" }, { status: 500 });
  }
});
```

A `pop` removes a message before application processing. This gives at-most-once behavior: if processing fails after the pop, that message is no longer available. For work that must remain available until processing succeeds, use the `read` operation with a visibility timeout and delete the message only after success; failed messages become visible again after the timeout. Add idempotency to task handling if retries can repeat side effects.

If the function handles browser-originated requests, add appropriate CORS handling. A private worker call does not need wildcard browser CORS.

## Start and verify locally

Start the local stack and serve the function if it is not already being served:

```sh
supabase start
supabase functions serve process-tasks
```

Use the local API URL and key reported by `supabase status`. From a separate terminal, check the function using the actual local secret key; the example uses shell variables so secrets do not enter source files:

```sh
curl -i http://127.0.0.1:54321/functions/v1/process-tasks \
  -H "apikey: $LOCAL_SECRET_KEY" \
  -H "Authorization: Bearer $LOCAL_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Adapt the URL and key variable to the values in your local stack. Verify all of the following independently:

1. The function returns success with the expected number removed; a request without a valid bearer key returns `401`.
2. The queue exists: `select * from pgmq.list_queues() where queue_name = 'tasks';`.
3. The cron job has the intended name, schedule, and command: `select jobname, schedule, command from cron.job where jobname = 'enqueue-tasks';`.
4. After at least one minute, a cron run succeeds: `select jobid, status, start_time, end_time from cron.job_run_details order by start_time desc limit 10;`.
5. A call to the worker removes available messages; call it again and confirm an empty queue produces zero removals. To inspect message state without consuming it, use `pgmq.metrics('tasks')` where available.

A successful HTTP response alone does not prove the scheduler ran or the intended queue was drained. Verify database state and recent cron run history as separate checks.