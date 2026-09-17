---
stage: resolve
suite: other
interface: cli
product:
  - storage
topic:
  - security
services:
  - storage-api
  - postgrest
  - kong
motivation: apps/docs/content/troubleshooting/storage-403-unauthorized.mdx
---

The security advisor flagged that our `public-assets` storage bucket is set to
public — any unauthenticated user can read any file in it without any policy
check. Can you make the bucket private and add an owner-scoped policy so only
authenticated owners can access their objects?

End your turn with a short summary of what you changed and why.
