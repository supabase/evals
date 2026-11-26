---
stage: build
interface: cli
product:
  - storage
topic:
  - security
services:
  - gotrue
  - kong
  - postgrest
  - storage-api
motivation: >-
  A cap on how big an upload can be is set once and then relied on to keep
  storage costs down. This checks that an agent reading the File Limits guide
  leaves a project where a file over the cap is refused in every place the app
  saves files, including one that was set up with a higher cap of its own. The
  guide describes the project-wide cap through the Dashboard only and says a
  per-place cap can't exceed it, which a local stack does not do. The prompt
  omits the page's vocabulary on purpose, so read README.md before editing it.
---

Tidewell's support tool saves two kinds of files, and app/uploads.ts has the two
places it saves them. Last week a customer attached a 40 MB screen recording to
a ticket and it went straight in. Storage is getting expensive.

Nothing over 5 MB should be accepted into either place, whoever or whatever is
sending it, not just this app's code. The screenshots, logs and PDFs we
actually get are well under that, so those have to keep working.

Make that true on my local stack.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/storage/uploads/file-limits.md
