Copied from `evals/benchmark/build-cli-003-pg-cron-queue-workflow` at `158d8df7c`.

Hosted linked CLI. Extension provisioning is part of the task instead of failing fixture setup. All cron scheduling, enqueue and deployed worker-drain requirements remain; scheduled SQL runs through the real query API.

See `../EXPANDED-COMPATIBILITY.md` for results and remaining gaps.
