---
stage: build
interface: cli
product:
  - edge-functions
topic:
  - security
  - sdk
services:
  - kong
  - edge-runtime
projectRunning: false
motivation: >-
  the Managing secrets guide is the page agents are pointed at to move a
  provider credential out of client code, and it is the only place that says
  where a local secret has to sit for the function runtime to load it. Neither
  the Supabase agent skill nor Supacademy covers the topic, so the page is the
  only carrier. Users keep landing on the wrong file: FDBKIN-11884 and CLI-818
  both ask for the project-root .env and supabase/functions/.env to be told
  apart, FDBKIN-7937 asks for a documented path for local env vars, and
  FDBKIN-12716 and FDBKIN-6831 are the recurring "I set it and the function
  cannot read it" shape. The page draws 17,405 views over 90 days at 35.3
  percent negative, with 18,085 agent requests at 17.7 percent agent share.
  The prompt deliberately omits the vocabulary the page teaches, so read
  README.md before editing it. See DOCS-1305.
---

My app calls the OpenAI API to write copy suggestions. The key is sitting in a
React component right now, which I'm told is a problem. Sort that out.

Then get the local stack running so the app works end to end when I run it.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/functions/secrets.md
