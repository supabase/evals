---
name: spark-api
description: Spark REST API for database schema, data, and email/password authentication.
---

Base URL: `$SPARK_PROJECT_URL`. Send the API key in the `apikey` header, not a query parameter. `$SPARK_SECRET_KEY` acts as `service_role`; `$SPARK_PUBLISHABLE_KEY` acts as `anon`. For a user session, also send `Authorization: Bearer <access_token>`. Keep keys and tokens out of output.

Use `Content-Type: application/json` for JSON bodies. Error responses contain diagnostic details in the body.

## Schema and SQL

| Method | Path | Request / behavior |
| --- | --- | --- |
| GET | `/system/v1/migrations` | Applied migrations, oldest first, including their SQL statements. Secret key required. |
| POST | `/system/v1/migrations` | `{"version":"...","name":"...","sql":"..."}`. Applies SQL and reloads the Data API schema cache. Use an unused version. Secret key required. |
| POST | `/database/query` | `{"query":"SELECT ...","parameters":[]}`. Read-only SQL inspection. Secret key required. |

Apply DDL through migrations and DML through the Data API. SQL compatibility is partial: `information_schema.tables` and `information_schema.columns` are unavailable. Inspect schema through migration statements or `SELECT * FROM pragma_table_info('<table>')`.

## Data API

Tables in `public` are available at `/rest/v1/<table>`.

| Method | Behavior |
| --- | --- |
| GET, HEAD | Read rows or headers. Supports `select`, filters such as `id=eq.1`, `order`, `limit`, and `offset`. |
| POST | Insert one JSON object or an array of rows. |
| PATCH | Update rows selected by query-string filters. |
| DELETE | Delete rows selected by query-string filters. |

`Prefer: return=representation` returns inserted or updated rows. `Prefer: count=exact` requests a count. `Accept: application/vnd.pgrst.object+json` requests one row as an object.

## Auth

Email/password only. Signup confirms the email immediately without sending mail. Signup and token requests return `access_token`, `refresh_token`, and `user`.

| Method | Path | Request / behavior |
| --- | --- | --- |
| POST | `/auth/v1/signup` | `{"email":"...","password":"..."}`. Creates a user and session. |
| POST | `/auth/v1/token?grant_type=password` | `{"email":"...","password":"..."}`. Signs in. |
| POST | `/auth/v1/token?grant_type=refresh_token` | `{"refresh_token":"..."}`. Refreshes a session. |
| GET | `/auth/v1/user` | Current user; requires the session bearer token. |
| POST | `/auth/v1/logout` | Ends the session; requires the session bearer token. |

## Limits

- No row-level security: publishable keys can read and write every row. RLS statements and policies are unsupported.
- No OpenAPI root (`GET /rest/v1/`), RPC, or views.
- Upsert and PUT on an existing row with an integer primary key are known to fail.
- No OTP, magic links, OAuth, password recovery, or MFA. A project secret key does not act as an Auth admin session.
