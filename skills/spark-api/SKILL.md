---
name: spark-api
description: Spark REST API for database schema and data operations.
---

Base URL: `$SPARK_PROJECT_URL`. Authenticate with `apikey: $SPARK_SECRET_KEY` (owner access). `$SPARK_PUBLISHABLE_KEY` is also available for Data API calls. Keep keys out of output.

Send `Content-Type: application/json` for JSON bodies.

| Method | Path | Request / behavior |
| --- | --- | --- |
| GET | `/system/v1/migrations` | List applied migrations and their statements. |
| POST | `/system/v1/migrations` | `{"version":"...","name":"...","sql":"..."}`. Version is a unique, increasing numeric string. |
| GET, POST, PATCH, DELETE | `/rest/v1/<table>` | PostgREST reads and writes. Supports `select`, `order`, and filters such as `id=eq.1`. |
| POST | `/database/query` | `{"query":"SELECT ...","parameters":[]}`. Read-only SQL inspection. |

Apply DDL through migrations and DML through the Data API.
