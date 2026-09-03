---
stage: build
suite: regression
interface: cli
product:
  - auth
topic:
  - sdk
  - security
services:
  - gotrue
  - kong
  - postgrest
motivation: >-
  the server-side client guide is what agents are pointed at to build a
  server-rendered signed-in experience, and it carries the highest agent share
  of any task-driven page in the docs cohort at 35.0 percent on 22,918 views.
  Server-side Auth is the densest label in feedback intake, and the asks repeat
  across FDBKIN-20970 and FDBKIN-6870 on trusting stored session state in server
  code, FDBKIN-10628 and FDBKIN-14804 on which call verifies a token, and
  FDBKIN-15214 and FDBKIN-11678 on losing cookies the response never carried.
  This eval determines whether the guide is effective at getting an agent to a
  dashboard that will not render someone's identity on the strength of a cookie
  alone, which is the failure the page warns about itself. The prompt
  deliberately omits that vocabulary, so read README.md before editing it.
  See DOCS-1303.
---

I have a Next.js app where people log in. I want the dashboard to render on the
server already knowing who is viewing it, and people should stay signed in as
they move between pages.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/auth/server-side/creating-a-client.md
