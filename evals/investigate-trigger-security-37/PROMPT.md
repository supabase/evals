---
motivation: derived from resolve-storage-001-upsert-missing-update-policy, https://supabase.com/docs/guides/troubleshooting/why-cant-i-uploadlistetc-my-public-bucket-Z6CmGt, supabase/agent-skills#112
stage: investigate
suite: trigger
interface: mcp
product:
  - database
topic:
  - rls
---

Our app has a public `avatars` bucket so profile photos have a public URL. Each user's avatar is stored at `<user_id>/avatar.png`, and the app uploads it with `upsert: true` so a new photo replaces the old one at that same path.

The very first upload for a user always works, but replacing an existing avatar fails. Find out why and fix it.
