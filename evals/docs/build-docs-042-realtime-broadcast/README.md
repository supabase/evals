# build-docs-042-realtime-broadcast

## What this eval measures

The subject is [Broadcast](https://supabase.com/docs/guides/realtime/broadcast), not the agent. The prompt is a product
request plus the page's url, and the checks say whether an agent that read the page gets a new room message to the right
people.

One claim: a message saved to a room reaches the room's members live, and nobody outside the room can receive it or slip
one in.

## Do not reintroduce the vocabulary

Keep all of these out of `PROMPT.md`:

realtime, broadcast, channel, private, topic, subscribe, websocket, socket, RLS, row level security, policy,
`realtime.messages`, `realtime.topic()`, extension, authorization, trigger, `realtime.send`, `broadcast_changes`,
`setAuth`, JWT, token, publication, Postgres Changes, presence, ack, self, REST, httpSend.

"Live", "members only" and "talks to Supabase directly" stay, because that is how the team would say it. `public` is
the schema name the seed already shows, so it is not stripped.

## The seed carries the contract

- `local/ROOMS.md` fixes `watchRoom(supabase, roomId, onMessage)` in `src/live.js`, and says messages arrive from three
  places. Two of them write straight to `public.messages`, so sending from the poster's browser does not reach anyone.
- `public.messages`, `public.room_members` and the helper `public.is_room_member` already keep non-members out of a
  room's rows. The eval measures the live path, not the table's access rules.
- `local/package.json` and `local/package-lock.json` pin `@supabase/supabase-js`.

## Scoring needs the npm registry

The scorer runs `npm ci` in the workspace so the agent's `src/live.js` can import its dependencies. It installs its own
pinned `@supabase/supabase-js` into a directory outside the workspace, so the clients it builds do not depend on what
the agent did to `package.json`. Both need network access to the npm registry. A failed install fails the eval. Read it
as a lost run, unless the note shows `npm ci` failed on a lockfile the agent changed.

## Do not drop the positive controls

The outsider, visitor and forgery checks pass for a project with no live path at all. The three member checks are what
make them mean something. The outsider and visitor checks also fail as could-not-measure when `watchRoom` joined nothing
on the client it was given, because then there is no topic to try directly. The forgery check fails as could-not-measure
in that case too, and when the scorer's own message on an open test topic never arrives.

## How the checks read the end state

- A member, a poster and a person from another room are created per run, with rooms named for the run. The member
  watches through the agent's `watchRoom`.
- Three messages go to the room, each with a run-scoped body: the poster inserts one through the API like the mobile app,
  the superuser inserts one with no signed-in user like the support inbox, and the poster calls `postMessage` from
  `src/messages.js` like the web app. Each member check needs that body at the callback within 10 seconds. The note
  names the route that delivered it, `broadcast` or `postgres_changes`, so a baseline can be read by route.
- The outsider and a visitor with no session watch three ways: through `watchRoom`, and directly on every topic the
  member's client joined, once as a members-only join and once as an open one. Any of the three bodies arriving fails
  the check.
- The forgery check has the outsider insert a whole row into the room's messages. A refusal counts only when the
  superuser then finds no such row. It also copies what the member's client received, swaps in a new body, and sends it
  as the outsider on each topic, both joins, over the socket and the HTTP endpoint. An HTTP send is listed as tried only
  when the request got a response. A stored row, or either body at the member's callback, fails the check.
- The shape of what the callback gets is not scored. Only that it carries the body.
- Before any of this, the scorer sends a test message from the database to an open topic and waits for it. If it never
  arrives, every probe fails as could-not-measure. Either the stack is not delivering, or the agent's migration broke
  sending from the database.
- The local stack allows open joins, as hosted projects do until "Allow public access" is off. An open join to the room's
  topic is attempted on purpose, because that setting is not the agent's to change locally.

## Order of the scorer

The scorer applies pending migrations with `supabase migration up --local` first, which writes to the database, so score
once per stack. It installs, then one script runs the probes in order: load, the database test message, setup, watching,
posting, then forging. A failed step marks every later probe as not run with its note. The script stops itself after 200
seconds, above the sum of its own waits.

## The guide has to actually be read

`the agent read the Broadcast guide the prompt referenced` requires a docs call that reached the page with content. Read
`docs.calls` before reading a score.

## Checks expected to saturate

The migration, install and load checks, and the visitor check. The signal is expected in the member checks and the
outsider check.

## What this eval does not score

- **Which mechanism carries the message.** Any route that delivers to members and nobody else passes, including changes
  read from the table instead of sent. The member checks name the route.
- **What the callback receives.** Only that it carries the message body.
- **Removing someone from a room.** Access is checked when the room is opened, and the prompt does not ask about leaving.
- **Typing indicators, presence and replay.** The prompt asks only for new messages.
- **Hosted projects.** The "Allow public access" setting and billing are out of reach locally.
