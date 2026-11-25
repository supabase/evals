# Rooms

Burrow is a team chat. A room's messages are for the people in that room and nobody else. `room_members` says who is
in which room, and the database already keeps everyone else out of a room's messages.

## Where messages come from

New messages land in `public.messages` from three places:

- The web app, through `postMessage` in `src/messages.js`.
- The mobile app, which inserts into `messages` through the API as the signed-in person.
- The support inbox, a server job that inserts customer replies straight into `messages`.

## Showing new messages in the web app

The room screen calls `watchRoom` from `src/live.js` when it opens:

```js
import { watchRoom } from './live.js'

const stop = await watchRoom(supabase, roomId, (message) => {
  appendToThread(message)
})
```

- `supabase` is the app's client, already signed in as the person looking at the room.
- `roomId` is `rooms.id`.
- The callback gets each new message in that room as a `messages` row: `id`, `room_id`, `author_id`, `body`,
  `created_at`.
- `watchRoom` returns, or resolves to, a function that stops watching.

The room screen closes with `stop()`.
