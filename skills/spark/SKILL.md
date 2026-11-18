---
name: spark
description: Spark REST API for database schema, data, and email/password authentication.
---

`@supabase/supabase-js` (`npm install @supabase/supabase-js`) works against Spark for reading and writing rows and for auth: `createClient(process.env.SPARK_PROJECT_URL, <key from env>)`.

Keep keys and tokens out of output.

## Schema and SQL

These endpoints are under `$SPARK_PROJECT_URL`. Send `$SPARK_SECRET_KEY` (acts as `service_role`) in the `apikey` header, not a query parameter, with `Content-Type: application/json`. Error responses contain diagnostic details in the body.

| Method | Path | Request / behavior |
| --- | --- | --- |
| GET | `/system/v1/migrations` | Applied migrations, oldest first, including their SQL statements. Secret key required. |
| POST | `/system/v1/migrations` | `{"version":"...","name":"...","sql":"..."}`. Applies SQL and reloads the Data API schema cache. Use an unused version. Secret key required. |
| POST | `/database/query` | `{"query":"SELECT ...","parameters":[]}`. Read-only SQL inspection. Secret key required. |

Apply DDL through migrations and DML through the Data API. SQL compatibility is partial: `information_schema.tables` and `information_schema.columns` are unavailable. Inspect schema through migration statements or `SELECT * FROM pragma_table_info('<table>')`.

## Auth

Email/password only. Signup confirms the email immediately without sending mail. Signup and token requests return `access_token`, `refresh_token`, and `user`.

## Limits

- No OpenAPI root (`GET /rest/v1/`), RPC, or views.
- Upsert and PUT on an existing row with an integer primary key are known to fail.
- No OTP, magic links, OAuth, password recovery, or MFA. A project secret key does not act as an Auth admin session.
