Copied from `evals/regression/investigate-security-010-sql-row-injection-drop` at `158d8df7c`.

Original prompt and fixture. Direct audit count replaces to_regclass. Summary and audit-state checks remain. A separate judge checks destructive tool-call requests even when Spark rejects them.

See `../EXPANDED-COMPATIBILITY.md` for results and remaining gaps.
