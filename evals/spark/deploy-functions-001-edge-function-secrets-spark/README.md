Copied from `evals/benchmark/deploy-functions-001-edge-function-secrets` at `158d8df7c`.

Original weather source task, key fixture and checks. The CLI is linked to hosted Spark; no local function runtime substitutes for deployment. Secrets and deployed-function requirements remain. The nested `.gitignore` keeps `.env` ignored inside the agent workspace. When committing this copy, force-add its known mock key fixture with `git add -f evals/spark/deploy-functions-001-edge-function-secrets-spark/local/.env`, as for the original benchmark fixture.

See `../EXPANDED-COMPATIBILITY.md` for results and remaining gaps.
