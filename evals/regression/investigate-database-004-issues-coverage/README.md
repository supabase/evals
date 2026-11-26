# Grouped Issues Inbox report

Tracks [DEBUG-311](https://linear.app/supabase/issue/DEBUG-311/add-mcp-support-for-issues) and [MCP #546](https://github.com/supabase/mcp/pull/546).

Two tables have RLS disabled. Platform-lite emits two critical security findings for the same check, which `get_issues` should group into one issue while retaining both affected resources. A third table has RLS enabled and should not appear in that group. Performance checks complete without findings; platform-lite deliberately returns an unsupported response for health checks.

The scenario checks warning-or-higher issue retrieval, a report that preserves the grouping and coverage distinction, and unchanged RLS settings. The report judge receives only the assistant's final report, so tool output alone cannot satisfy the reporting requirement.

The `codex-gpt-6-luna-issues-source` experiment pins the MCP source revision under review. Run it with:

```sh
pnpm eval -- --suite regression --experiment codex-gpt-6-luna-issues-source --eval investigate-database-004-issues-coverage --runs 1
```

For local iteration, set `SUPABASE_MCP_REPO_PATH` in the repository's `.env` to a built MCP checkout; it overrides the pinned revision. The default published MCP version may not expose this tool yet.
