---
stage: build
interface: cli
product:
  - realtime
  - database
topic:
  - security
  - sdk
services:
  - gotrue
  - kong
  - postgrest
  - realtime
motivation: >-
  A chat room needs each new message pushed to the people in the room, and
  only to them. Customers and agents send from the database to a client that
  never receives it, or open the room to every signed-in user so that it does.
  This checks that an agent reading the Broadcast guide gets a new message to
  the room's members as it lands and to nobody outside the room. The prompt
  omits the guide's vocabulary on purpose, so read README.md before editing it.
---

Burrow is our team chat. Right now people only see new messages in a room when
they reload. I want a new message to show up for everyone in the room the
moment it's saved, whether it came from the web app, the mobile app or the
support inbox. ROOMS.md says where the web app's part goes.

Rooms are members only. Nobody outside a room should ever see its messages or
be able to slip a message into it, even someone who skips our app and talks to
Supabase directly. Set that up in the local project and make sure it works on
the local stack.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/realtime/broadcast.md
