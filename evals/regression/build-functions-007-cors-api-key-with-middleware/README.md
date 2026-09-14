# build-functions-007-cors-api-key-with-middleware

Regression sibling of the `@supabase/server` pair (005/006), for
`@supabase/middleware`. The prompt names the package and asks for an Edge
Function that composes the built-in CORS middleware with a hand-written API-key
gate, so the eval measures "agents compose with the package correctly when
pointed at it", not discovery.

## Seed

- `local/supabase/config.toml`: a stock project with the edge runtime on Deno 2.
  `verify_jwt` is left at its default. The callers in the prompt send no
  Supabase JWT, so the agent has to turn platform JWT verification off for
  this function or every request dies at the gateway before the middleware
  runs.
- `local/supabase/functions/.env`: `NOTES_API_KEY=nk_live_7f3a9c`. The prompt
  says the secret is already there; the scorer sends the same value.

## Scorer

Behavioral checks hit the served function through Kong: requests with no key
and with the wrong key (both `401`), and one with the right key (`200`,
`{ ok: true, keyId: "7f3a9c" }`). Two gating source checks require an
`@supabase/middleware` import and a `defineMiddleware` call, so a hand-rolled
solution fails even if it behaves.

The local Kong (2.8.x) runs its own CORS plugin on `/functions/v1/*`: it
answers `OPTIONS` preflights before they reach the function and rewrites
`Access-Control-Allow-Origin` to `*` on every response. Neither can be
asserted through the gateway. What does survive is `Vary: Origin`, which a
CORS middleware appends when it resolves a specific allowed origin, so the
scorer checks that header on the successful request instead.
