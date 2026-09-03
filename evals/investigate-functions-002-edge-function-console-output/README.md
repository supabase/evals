# Notes on the seed

`remote/logs.jsonl` is the first eval seed to use `source: "edge-function-runtime"`.
That source writes to platform-lite's `function_logs` table only, which the unified
`logs` view labels `source = 'function_logs'` — the Edge Function console/stdout
stream. The `source: "edge-function"` rows are the separate request/response stream
(`function_edge_logs` + `edge_logs`) and carry no console content, so an agent that
stops at the request envelopes has nothing to report but 200s.
