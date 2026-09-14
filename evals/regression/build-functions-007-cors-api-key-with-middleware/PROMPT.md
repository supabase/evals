---
stage: build
interface: cli
cliVersion: 2.109.1
product:
  - edge-functions
topic:
  - sdk
  - security
services:
  - kong
  - edge-runtime
projectRunning: false
motivation: SDK-1420
---

Build and serve a Supabase Edge Function named `notes-api` for this project,
reachable over HTTP at `/functions/v1/notes-api`.

Put it together with the **`@supabase/middleware`** package. Import it directly
in your function:

```ts
import { pipeline } from "npm:@supabase/middleware";
```

Two things need to run in front of the handler:

1. **CORS** for our web app at `https://app.example.com`. Browsers send
   preflight requests first, so those have to work too.

2. **An API key check.** The callers are third-party services, not signed-in
   Supabase users. They send their key in an `x-api-key` header, and it has to
   match the `NOTES_API_KEY` secret that is already in
   `supabase/functions/.env`. Anything else gets a `401` and never reaches the
   handler.

Write the key check as your own middleware with the package's
`defineMiddleware`. Our keys look like `nk_live_7f3a9c`; have the middleware put
the part after the last underscore on `ctx` as `ctx.caller.keyId`, and have the
handler return `{ "ok": true, "keyId": ctx.caller.keyId }` as JSON.

Get the local stack running so the function is reachable at the path above.
