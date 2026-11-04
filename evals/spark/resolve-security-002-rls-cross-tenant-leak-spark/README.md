Copied from `evals/benchmark/resolve-security-002-rls-cross-tenant-leak` at `158d8df7c`.

Starts with unprotected notes/memberships, reproducing overly broad access. Both users use real publishable-key sessions. All nine isolation/CRUD requirements remain; catalog failure does not stop behavior checks, and delete targets a stable row ID.

See `../EXPANDED-COMPATIBILITY.md` for results and remaining gaps.
