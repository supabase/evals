# build-docs-027-functions-quickstart

## What this eval measures

The subject is [Getting Started with Edge Functions](https://supabase.com/docs/guides/functions/quickstart), not the
agent. The prompt is a product request plus the page's url, and the checks say whether an agent that read the page
produced working work. A gap in the page counts as a failure here.

One claim: a function serves locally and returns the expected response. The signup screen in the seed calls a
function that does not exist, and the scorer calls it the way the page's own `curl` does and reads what comes back.

### Confirming the claim

Read against the page, not run. This session had no way to run the CLI, so none of the page's commands were executed.

- **Holds on the page's own terms.** Steps 2 to 4 say the starter takes `{ "name": ... }` and answers
  `{ "message": "Hello <name>!" }` at `/functions/v1/<name>`, with the publishable key in an `apikey` header. That is
  the contract the scorer probes, and nothing on the page contradicts it.
- **Checked.** `supabase.functions.invoke` parses a response as JSON only when `Content-Type` is `application/json`,
  and otherwise returns a string (`@supabase/functions-js` 2.4.5, `FunctionsClient.js`). The starter's
  `Response.json(...)` sets it; a hand-built `new Response(JSON.stringify(...))` does not. The page does not say why
  `Response.json` is used.
- **Not checked.** What `supabase functions new` writes with the pinned CLI, whether `supabase start` alone serves a
  new function once a `supabase functions serve` process has exited, and what the page means by "the complete `curl`
  command already in `functions/hello-world/index.ts`". The starter it shows has no such comment, and the path
  lacks the `supabase/` prefix.

## Why this is not an existing eval

- `evals/cli/build-functions-008-serve-local-secret` builds and serves a function, with a shared secret in the way.
  It has no url, so it measures the CLI and the agent, not a page.
- `build-docs-010-edge-function-auth` serves a function and probes who gets what back. Its subject is the auth page,
  and its function is behind a credential design the user has to choose.
- `build-docs-007-edge-function-secrets` is about where a local secret sits.
- `evals/cli/deploy-functions-002-deploy-and-call` deploys to a hosted project.

None of them asks for a plain function and checks that it answers, which is the page's first promise.

## Do not reintroduce the vocabulary

The prompt asks for a greeting on a screen and for the local project to be running. It never says how a function is
made, started or called. Keep all of these out of `PROMPT.md`:

edge function, function, serverless, Deno, `Deno.serve`, `supabase functions new`, `supabase functions serve`,
`supabase start`, serve, deploy, curl, `/functions/v1`, apikey, publishable key, `withSupabase`, `@supabase/server`,
`Response.json`, JSON, Docker, hot reload, runtime.

The route is not named. `app/signup.ts` calls `welcome`, so the scorer's address is fixed by the seed, and the page is
what turns that name into a folder and a url.

## The seed carries the contract

`local/app/signup.ts` is the one place that says what the function has to do: it is called `welcome`, it takes
`{ name }`, and its `message` is the whole greeting, worded like "Hello Maria!". `local/app/supabase.ts` is the client
it uses. `local/supabase/config.toml` is the project as `supabase init` leaves it, with no function.

This puts the contract in the seed rather than the prompt, so the agent has to find it by reading the app. That costs
a discovery step and buys a prompt that is a product request. The seed's comments use product words; "function" and
"backend" appear only as the seed's own framing of the missing piece.

`cliVersion` is pinned because the starter the page shows imports `@supabase/server`, which validates the new API keys,
and the edge runtime only injects those on a new enough CLI. `projectRunning: false`, so the agent starts the stack
and owns the ordering. `services` is `kong`, `postgrest` and `edge-runtime`: the status call reports no `API_URL`
without `postgrest` when `kong` runs alone.

## Do not drop the positive controls

There are no absence checks, so no check passes for an agent that built nothing. Every check needs a real answer from
the function. The two probes use names made up per run, so a handler that hardcodes the page's `Functions` or `World`
fails `the greeting names whoever asked`, and so does one that remembers the first name it was given.

## The guide has to actually be read

The last check resolves the guide through the harness's own docs result, because a `search_docs` hit carries the url
in its result rather than its request. It requires retrieved content, not just a url that was reached. The match is
exact on the path, because the page links to `quickstart-dashboard` and a prefix match would count that as a read.

Read `docs.calls` before reading the score. Docs evals run on one experiment and it is a no-skills one, so there is no
second arm to rule out prior knowledge. An empty `docs.calls` means the run measured nothing about the page, whatever
the checks say.

## What this eval does not score

- **Steps 5 to 7: login, link, deploy and the live call.** They need a hosted project. `deploy-functions-002` in the
  CLI suite covers a deploy.
- **A browser calling the function.** The page's note about CORS is a second claim, and the page for it is
  `functions/cors`. The probes call from a script, which sends no preflight.
- **Refusing a caller with no key.** The probes always send the key. Who the function lets in is
  `build-docs-010-edge-function-auth`.
- **The shape of the starter.** Whether the agent used `supabase functions new`, `withSupabase` or a bare
  `Deno.serve` changes nothing the checks look at.
- **Hot reloading.** What the page promises about saving while `functions serve` runs is the runtime's behavior, and a
  scorer that edits the source mid-run would be measuring the pinned CLI.
- **Status codes and other methods.** The prompt names neither, so any 2xx on a POST passes.
- **The Dashboard route.** That is `quickstart-dashboard`.

## Predictions

This is a mainstream task, so expect saturation. Agents know the pattern, and the page's starter does the whole job.
The signal is in the agent leaving the stack down, putting the handler somewhere the runtime does not look, and
writing it for Node.

| What the agent does | running | answers | greets | JSON |
| --- | --- | --- | --- | --- |
| Follows the page: `functions new`, edit, start | pass | pass | pass | pass |
| Hand-writes `Deno.serve` with `Response.json` | pass | pass | pass | pass |
| Returns `JSON.stringify` with no `Content-Type` | pass | pass | pass | fail |
| Hardcodes `Hello Functions!` | pass | pass | fail | pass |
| Wrong wording, or a bare string | pass | pass | fail | pass |
| Puts the function outside `supabase/functions/` | pass | fail | not run | not run |
| Writes it for Node | pass | fail | not run | not run |
| Leaves the stack down | fail | not run | not run | not run |

`greets` and `JSON` report "not run" as a failure, with the reason in the note.

The probe checks ran against a fake function server in 15 cases, each with its verdicts written down first: a correct
handler, extra fields, a charset on the content type, the page's hardcoded greeting, `text/plain`, no content type,
wrong wording, a bare string, a handler that remembers its first name, a 404, a 503 that never boots, a 401, a 500, the
stack down and nothing listening. All held. The agent behaviors in the table are predictions that no real run has
confirmed.

## Risks

- **The baseline is unrecorded.** Needs the `run-evals-changed` label.
- **`functions serve` may end with the agent's shell.** The page tells the reader to keep that terminal open. If the
  serve process is what answers and it is gone by scoring, a correct function reads as not served. Not verified; if a
  baseline shows `answers` red while the agent's transcript shows it working, look here first.
- **A cold worker.** `npm:@supabase/server` is fetched at boot. The probe retries a 502, a 503 or a refused connection
  twice, four seconds apart, so a slow first boot costs time rather than the check. A sandbox with no network answers
  503 every time, and the note says so; treat that run as lost.
- **The JSON check is stricter than `curl`.** `curl` prints the body whatever the header says, so a handler without a
  `Content-Type` looks right in the terminal and gives the app a string. The check follows the app, and the seed's
  `data.message` is why.
- **The wording is exact.** `Hello <name>!` comes from one comment in the seed. An agent that words it differently
  fails `greets`, which is the seed's contract rather than a guess.
