---
stage: build
interface: cli
product:
  - database
topic:
  - security
  - sql
services: []
motivation: >-
  A database function that calls out with a credential needs somewhere to keep
  it. Customers and agents put the key in the function body, a trigger, a
  migration, or a database setting the platform refuses. This checks that an
  agent reading the Vault guide stores a signing key encrypted, keeps it out of
  the repo and away from app users, and signs links with whatever key is
  current. The prompt omits the guide's vocabulary on purpose, so read
  README.md before editing it.
---

Plantly's reports sit on a CDN that only serves signed links. When someone
signed in to the app opens a report, the app should get a signed download link
from the database. DOWNLOAD_LINKS.md has the link format and says where the
CDN's signing key is.

The repo is shared with contractors, and so are copies of the database they
debug with, so the key can't be readable in either. People using the app must
never be able to get the key. Ops changes the key now and then, and links have
to keep working when they do without anyone touching the code. Set that up in
the local project and make sure it works on the local database.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/database/vault.md
