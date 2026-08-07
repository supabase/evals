Deploys to [evals-runner](https://vercel.com/supabase/evals-runner) project on Vercel which houses the API deployments, Sandboxes, and Workflows for running evals.

# Setup

To the repo's root `.env` add:

```env
# From `vercel deploy` output, e.g. https://<preview-slug>.vercel.app
VERCEL_DEPLOY_URL=...

# From https://vercel.com/supabase/evals-runner/settings/deployment-protection#protection-bypass-for-automation
VERCEL_AUTOMATION_BYPASS_SECRET=...

# Git branch, tag, or commit SHA the Sandbox evaluates. It must already be pushed.
EVALS_RUNNER_REF=main
```

Test the workflow with:

```bash
source "$(git rev-parse --show-toplevel)/.env" && curl -sS -X POST "$VERCEL_DEPLOY_URL/api/hello-world" -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET"
```

Run any experiment and eval in a fresh Vercel Sandbox:

```bash
source "$(git rev-parse --show-toplevel)/.env" && curl -sS -X POST "$VERCEL_DEPLOY_URL/api/run-eval" -H "content-type: application/json" -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET" -d "{\"experiment\":\"codex-gpt-5.4-mini\",\"evalId\":\"build-rls-002-own-todos-client\",\"ref\":\"$EVALS_RUNNER_REF\"}" | jq
```

Runs use `main` by default when `ref` is omitted.

Delete stopped eval sandboxes older than an hour:

```bash
source "$(git rev-parse --show-toplevel)/.env" && curl -sS -X POST "$VERCEL_DEPLOY_URL/api/cleanup-sandboxes" -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET"
```
