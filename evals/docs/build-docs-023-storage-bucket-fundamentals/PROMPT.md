---
stage: build
interface: cli
preinstallCli: true
startLocalStack: true
product:
  - storage
topic:
  - sdk
services:
  - kong
  - postgrest
  - storage-api
motivation: >-
  A bucket's visibility and upload limits are set once and then relied on. This
  checks that an agent reading the Storage Buckets guide sets up one bucket for
  files anyone with the link can see and one that a link alone can't open, each
  turning away files of the wrong size or type. The guide states the
  visibility but only names the limits, and gives the settings only in the
  JavaScript client's units. The prompt omits the page's vocabulary on purpose,
  so read README.md before editing it.
---

Fernhill's backend is about to start saving two kinds of files, and the project
has nowhere to put them yet. app/files.ts has the two places it expects, by
name.

The press photos go on the marketing site, so anyone with the link should be
able to see them. They're only ever images, small web versions, so nothing over
2 MB. The invoices are PDFs that finance generates for every order, up to 10 MB
each. Nobody should be able to open one just by having a link to it.

For both, anything that isn't the right kind of file or is too big should be
turned away. Set the project up so both work on my local stack.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/storage/buckets/fundamentals.md
