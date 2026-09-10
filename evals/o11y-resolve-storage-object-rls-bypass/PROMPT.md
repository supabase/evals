---
stage: resolve
suite: other
interface: cli
product:
  - storage
topic:
  - rls
  - security
services:
  - storage-api
  - postgrest
  - kong
motivation: apps/docs/content/troubleshooting/storage-403-unauthorized.mdx
---

Our storage objects appear to be accessible without any ownership checks — there
are no SELECT policies on `storage.objects`, meaning any authenticated caller
can browse every object in every bucket. Can you add a proper SELECT policy that
restricts access to the object owner?

End your turn with a short summary of what you changed and why.
