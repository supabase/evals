---
name: spark
description: "Spark is a lightweight Supabase. It supports Supabase's Auth and Data APIs, including their client libraries"
---

Spark is a lightweight Supabase. You can use `@supabase/supabase-js` with `createClient(process.env.SPARK_PROJECT_URL, <key from env>)`. Keep keys and tokens out of output.

## Schema and SQL

Spark has no direct DDL path through the Data API. Send `$SPARK_SECRET_KEY` (acts as `service_role`) in the `apikey` header to these endpoints under `$SPARK_PROJECT_URL`:

- `POST /system/v1/migrations` with `{"version","name","sql"}` applies DDL and reloads the schema cache. Use an unused version. `GET` lists applied migrations and their SQL.
- `POST /database/query` with `{"query","parameters":[]}` runs read-only SQL for schema inspection.

Apply DDL through migrations and DML through the Data API. `information_schema` is unavailable; use migration SQL or `SELECT * FROM pragma_table_info('<table>')`.

## Auth

Email/password only. Signup confirms immediately and sends no mail.

## Current limitations

Spark currently covers only the Data API and email/password auth. Treat any other Supabase service as unavailable unless this skill describes it. Known gaps:

- No OpenAPI root (`GET /rest/v1/`), RPC, or views.
- Upsert and PUT on an existing row with an integer primary key fail.
- No OTP, magic links, OAuth, password recovery, or MFA. The secret key is not an Auth admin session.
