---
stage: resolve
suite: other
interface: cli
product:
  - storage
topic:
  - security
  - self-hosting
motivation: apps/docs/content/troubleshooting/storage.mdx
---

Our storage service has a wildcard CORS configuration (`allowedOrigins: ["*"]`),
which allows any website to make cross-origin requests to our storage bucket,
potentially enabling CSRF attacks or unauthorized data access. Can you lock it
down to our production domain only?

End your turn with a short summary of what you changed and why.

> Note: CORS configuration lives in Supabase config.toml and is applied at the
> platform level — it cannot be inspected or changed via SQL. Score is based on
> the agent's reported fix.
