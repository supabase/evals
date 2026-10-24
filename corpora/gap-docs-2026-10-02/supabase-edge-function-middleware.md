# Compose Edge Function middleware

Use this pattern when a Supabase Edge Function needs ordered request checks, typed values passed to its handler, and browser CORS. It uses `@supabase/middleware` directly; it does not use the separate `@supabase/server` authentication wrapper.

## Prerequisites

- A Supabase project with the CLI and Docker available. From the project directory, start the local stack with `supabase start`.
- A function directory at `supabase/functions/<function-name>/` and a local secrets file at `supabase/functions/.env`.
- The package `@supabase/middleware` available to the Edge Function runtime.
- Decide which origin, request headers and methods browsers may use. Allow only origins and headers required by your application.
- For a function authenticated by its own non-JWT credential, configure that function's gateway JWT verification so the gateway allows requests to reach the function. The function middleware must perform the actual credential check; disabling gateway JWT verification does not authorize a caller.

Local Edge Function secrets are loaded from `supabase/functions/.env`. Keep real secret values out of source code, responses, and logs.

## Compose CORS and a caller-key gate

The example below is adaptable. Replace the function behavior, allowed origin, method and headers for your application. Its sample key format is illustrative; match your own credential format. Put the secret in `supabase/functions/.env`, for example:

```dotenv
NOTES_API_KEY=replace-with-a-local-test-key
```

Create `supabase/functions/<function-name>/index.ts`:

```ts
import { getEnv, pipeline } from "npm:@supabase/middleware";
import { withCors } from "npm:@supabase/middleware/cors";
import { defineMiddleware } from "npm:@supabase/middleware";

type Caller = { keyId: string };

const withCallerKey = defineMiddleware<
  "caller",
  void,
  Record<never, never>,
  Caller
>({
  key: "caller",
  run: () => async (req) => {
    const expected = getEnv("NOTES_API_KEY");
    const supplied = req.headers.get("x-api-key");

    // Missing server configuration is an operational error, not an authorized request.
    if (!expected) {
      console.error("Caller-key secret is not configured");
      return Response.json({ error: "Service unavailable" }, { status: 503 });
    }

    if (!supplied || supplied !== expected) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const separator = supplied.lastIndexOf("_");
    const keyId = separator >= 0 ? supplied.slice(separator + 1) : "";
    if (!keyId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Returning a contribution adds ctx.caller for downstream middleware and the handler.
    return { caller: { keyId } };
  },
});

export default {
  fetch: pipeline(
    [
      // CORS runs first, so preflight can finish before the key check.
      withCors({
        origin: ["https://app.example.com"],
        allowedHeaders: ["content-type", "x-api-key"],
        allowedMethods: ["GET", "POST", "OPTIONS"],
      }),
      withCallerKey(),
    ],
    async (_req, ctx) =>
      Response.json({ ok: true, keyId: ctx.caller.keyId }),
  ),
};
```

The `defineMiddleware` type parameters name the context key, configuration type, upstream context required, and contributed value. This gate needs no options or upstream values and contributes a typed `caller` object. `pipeline` runs entries in array order; its handler receives the merged contributions as inferred `ctx`. Returning a `Response` from middleware short-circuits the request, so failed credentials never reach the handler.

Use the runtime's environment API inside the per-request callback. Do not read request-specific bindings while constructing the pipeline. Keep the CORS middleware before any gate that can reject a request: browsers send an `OPTIONS` preflight without the actual caller credential, and an origin allowlist should answer that request before authentication runs.

For another key format, change the key ID extraction to the documented format your service issues. Do not log or return the full credential. If the secret is missing, fix runtime configuration instead of treating an unset expected value as a valid key.

## Serve locally

Start the stack, then serve the named function. Adapt the function name and port if your project config differs.

```sh
supabase start
supabase functions serve <function-name> --env-file supabase/functions/.env
```

The default local Functions URL is `http://127.0.0.1:54321/functions/v1/<function-name>`. Keep the serving process running while you make requests.

## Verify the middleware path

Use a disposable local key whose final underscore-delimited component is recognizable. Set it in the local environment for the test shell without printing it or placing it in command history. These commands use placeholders; replace them with your local function name and test values.

First inspect preflight from the allowed origin:

```sh
curl -i -X OPTIONS 'http://127.0.0.1:54321/functions/v1/<function-name>' \
  -H 'Origin: https://app.example.com' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,x-api-key'
```

Confirm the response allows the exact origin, requested method, and `x-api-key` header. Preflight should complete without the API key gate returning 401. Check the response produced by the function path; gateway-generated wildcard CORS headers alone do not prove that the function's origin policy ran.

Then exercise actual requests:

```sh
curl -i 'http://127.0.0.1:54321/functions/v1/<function-name>' \
  -H 'Origin: https://app.example.com' \
  -H "x-api-key: $NOTES_API_KEY"

curl -i 'http://127.0.0.1:54321/functions/v1/<function-name>' \
  -H 'Origin: https://app.example.com'

curl -i 'http://127.0.0.1:54321/functions/v1/<function-name>' \
  -H 'Origin: https://app.example.com' \
  -H 'x-api-key: incorrect-test-key'
```

Confirm the configured test key reaches the handler and returns JSON with the expected key ID, while missing and incorrect keys each return 401 and never return the handler's success body. Confirm the actual success and 401 responses both include the allowed-origin CORS headers. Also try a disallowed origin and confirm it does not receive an allowed-origin response header.

When origin selection varies by the request's `Origin`, the response must include `Vary: Origin`. If another layer already sets `Vary`, append `Origin` to that comma-separated value; do not replace values such as `Accept-Encoding`. Inspect `Vary` on preflight and actual responses, including rejected-key responses. A successful `OPTIONS` request that came from gateway-level handling is not evidence that the function's CORS pipeline or response headers work.

If any request returns a worker error or times out, inspect the function runtime logs and confirm that the local secret reached the runtime. Treat a failure before the handler as unresolved execution or configuration, not as a successful auth or CORS check.
