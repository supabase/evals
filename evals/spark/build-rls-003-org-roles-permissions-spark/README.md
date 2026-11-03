Copied from `evals/benchmark/build-rls-003-org-roles-permissions` at `158d8df7c`.

Starts with ordinary unprotected data, preserving the reported overly broad access. All 15 role/isolation requirements remain. Real signup sessions replace SQL SET ROLE impersonation; business rows reset between checks to preserve the original rollback isolation.

See `../EXPANDED-COMPATIBILITY.md` for results and remaining gaps.
