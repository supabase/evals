---
stage: build
interface: cli
product:
  - storage
  - auth
topic:
  - security
  - sdk
services:
  - gotrue
  - kong
  - postgrest
  - storage-api
motivation: >-
  An S3 client reaches Supabase Storage either with the project's S3 keys,
  which skip every access rule, or as a signed-in person, which keeps them.
  Customers ask which one limits a person to their own files, and report
  signature errors locally when the person's token goes with the wrong key.
  This checks that an agent reading the S3 Authentication guide gives a shipped
  desktop app access scoped to each person and a server job access to
  everything. The prompt omits the guide's vocabulary on purpose, so read
  README.md before editing it.
---

Fernnotes has a desktop app that syncs each person's notes to our Supabase
project, and a nightly backup job on our server that copies all of them. Both
use the AWS S3 SDK. STORAGE.md explains how it fits together. The two
storage.js files that hand out the clients are still empty.

People sign in to sync. Each person must only ever be able to see and change
their own notes, even with a tampered copy of the desktop app, since everything
in desktop/ ships to customers. The backup job has to get everyone's notes. Set
that up in the local project and make sure it works on the local stack.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/storage/s3/authentication.md
