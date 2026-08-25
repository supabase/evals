# Notes on the seed

`remote/logs.jsonl` is the first eval seed to use `source: "edge-function-runtime"`.
That source writes to platform-lite's `function_logs` table only, which the unified
`logs` view labels `source = 'function_logs'` — the Edge Function console/stdout
stream. The `source: "edge-function"` rows are the separate request/response stream
(`function_edge_logs` + `edge_logs`) and carry no console content, so an agent that
stops at the request envelopes has nothing to report but 200s.

The scenario needs an MCP server that ships `query_logs` (0.10.0+). The repo-wide
`MCP_SERVER_VERSION` is now 0.11.0, so it runs under the default experiments and
needs no version-pinned experiment.
