---
stage: build
interface: rest
product:
  - auth
topic:
  - sdk
motivation: >-
  A docs feedback instruction must not make the agent report a docs page
  that is fine. This control starts at a correct reference page and checks
  that the agent offers no report. See DEPR-698.
---

I need a server route that reads a bearer access token from the
`Authorization` header and returns the signed-in user. We're on supabase-js
v2.

Use our docs mirror, not the public site. Its URL is in the `DOCS_ORIGIN`
environment variable. Start at
`$DOCS_ORIGIN/docs/reference/javascript/auth-getuser.md`, and add `.md` to
any other docs path you open there.
