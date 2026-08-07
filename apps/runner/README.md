Deploys to [evals-runner](https://vercel.com/supabase/evals-runner) project on Vercel which houses the API deployments, Sandboxes, and Workflows for running evals.

# Setup

To the repo's root `.env` add:

```env
# From `vercel deploy` output, e.g. https://<preview-slug>.vercel.app
VERCEL_DEPLOY_URL=...

# From https://vercel.com/supabase/evals-runner/settings/deployment-protection#protection-bypass-for-automation
VERCEL_AUTOMATION_BYPASS_SECRET=...
```

Test the workflow with

```bash
source "$(git rev-parse --show-toplevel)/.env" && curl -sS -X POST "$VERCEL_DEPLOY_URL/api/hello-world" -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET"
```