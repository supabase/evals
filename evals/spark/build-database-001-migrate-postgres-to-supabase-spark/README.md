Copied from `evals/benchmark/build-database-001-migrate-postgres-to-supabase` at `158d8df7c`.

Original binary dump, hosted destination and real CLI. Direct table probes, invalid-FK inserts and next-ID inserts replace PostgreSQL catalog/sequence checks; all counts, constraints, index and ID-advance requirements remain. Separate MCP-enabled comparison uses the same task and scorer.

See `../EXPANDED-COMPATIBILITY.md` for results and remaining gaps.
