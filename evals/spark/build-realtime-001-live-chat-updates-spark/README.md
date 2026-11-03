Copied from `evals/regression/build-realtime-001-live-chat-updates` at `158d8df7c`.

Business tables and room are seeded without RLS/auth.uid or an unsupported publication. The agent must provision Realtime. Publication and advice checks both run even if the catalog is unavailable.

See `../EXPANDED-COMPATIBILITY.md` for results and remaining gaps.
