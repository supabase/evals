# investigate-functions-002-console-output-behind-200

Tracks supabase/mcp#375: on hosted projects `get_logs` is hidden and `query_logs` is the only
logs tool, and its ClickHouse hint names `function_edge_logs` but not `function_logs`, and
`log_attributes['<key>']` but not `event_message`. Agents asked for an edge function's console
output reach the request envelope, find nothing wrong, and report that the output was never
stored. The fix under review is supabase/mcp#376.

## Setup

`order-sync` is a deployed function that pushes orders to a warehouse. A line whose SKU is not
in the warehouse feed is logged with `console.error` and skipped, and the function still returns
200 — so the request/response stream cannot show the failure.

The logs seed both edge-function streams separately (platform-lite keeps them as distinct
`source` values, exactly like hosted):

| seed `source`          | unified-stream `source` | what it holds                                                            |
| ---------------------- | ----------------------- | ------------------------------------------------------------------------ |
| `edge-function`        | `function_edge_logs`    | one `POST \| 200 \| …/order-sync` envelope per invocation — all 200s     |
| `edge-function-runtime`| `function_logs`         | the console lines: 3 `console.error` lines for orders ORD-48213/48217/48220 (SKU `WH-1002` missing from the feed), `console.log` lines for the rest, and a boot line |

An unrelated `send-receipt` function and two Postgres checkpoint lines are seeded as noise.

The console line text is only in `event_message`. `log_attributes` on those rows carries
`level`, `event_type`, `function_id`, `execution_id`, `deployment_id`, `version` — no message
key — matching the hosted `function_logs` shape.

## What it scores

The prompt asks for the exact error, so the checks are deterministic on the agent's final
report: it must quote the SKU (`WH-1002`), attribute the failure to the SKU missing from the
warehouse feed, and name at least one of the affected orders.

Two failure modes both score zero here, and both were observed on hosted projects:

1. The agent queries `function_edge_logs` (the source the hint names), sees only 200 envelopes,
   and reports that the function logs nothing or that console output is not stored.
2. The agent reaches `function_logs` but reads `log_attributes[...]` per the hint, finds no
   message key, and reaches the same conclusion.
