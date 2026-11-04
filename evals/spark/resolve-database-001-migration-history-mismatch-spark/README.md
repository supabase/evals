Copied from `evals/benchmark/resolve-database-001-migration-history-mismatch` at `158d8df7c`.

Original 25 profiles and two recorded versions, seeded into Spark native migration history. generate_series uses its value column. Native schema recreation is omitted; harness fixture bookkeeping is removed. All reconciliation, data-preservation and real CLI-workflow requirements remain.

See `../EXPANDED-COMPATIBILITY.md` for results and remaining gaps.
