# Grouped Issues Inbox report

Tracks [DEBUG-311](https://linear.app/supabase/issue/DEBUG-311/add-mcp-support-for-issues) and [MCP #546](https://github.com/supabase/mcp/pull/546).

Two tables have RLS disabled. Platform-lite emits two critical security findings for the same check, which `get_issues` should group into one issue while retaining both affected resources. A third table has RLS enabled and should not appear in that group. Performance checks complete without findings; platform-lite deliberately returns an unsupported response for health checks.

The scenario checks warning-or-higher issue retrieval, a report that preserves the grouping and coverage distinction, and unchanged RLS settings. The report judge receives only the assistant's final report, so tool output alone cannot satisfy the reporting requirement.

Run against a built MCP checkout containing `get_issues` by setting `SUPABASE_MCP_REPO_PATH` in the repository's `.env`, then:

```sh
pnpm eval -- --suite regression --experiment codex-gpt-6-luna --eval investigate-database-004-issues-coverage --runs 1
```

The default published MCP version may not expose this tool yet. See the repository's contributing guide for selecting an MCP source revision in an experiment.
