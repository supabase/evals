# What this eval measures

The subject under test is the [server-side client guide](https://supabase.com/docs/guides/auth/server-side/creating-a-client), not the agent. A gap in the guide counts as a failure.

The one claim: **the dashboard must not render a viewer's identity on the strength of a cookie alone.** The page warns about this itself. Everything else the eval checks is secondary.

## Do not reintroduce the vocabulary

`PROMPT.md` never says cookie, session, token, middleware, proxy, server client, verify, or spoof, and it never names an auth method. Stripping that is the measurement.

The prompt tells the agent to rely on the guide rather than on what it already knows, so a pass is evidence about the page instead of about the model's priors. Keep that instruction when loosening the rest.

## The seed carries the contract

`app/page.tsx` fixes the sign-in form's field names and posts them to `POST /login`. `app/login/route.ts` fixes that endpoint's contract: 303 to `/dashboard` on success, and whatever keeps the browser signed in comes back on that response. Both are unwired.

`app/dashboard/page.tsx` fixes two things: the viewer's email renders inside `data-testid="viewer-email"`, and anyone not signed in belongs on `/`. The fixed `data-testid` is what makes the probes provable. Without it the tampered-cookie check cannot tell "did not render the viewer" from "rendered nothing at all".

`.env.example` ships both variable names empty. Without somewhere for the values to land, the choice of client and key is not observable.

A route handler is the login target rather than a client-side call, so the probe can post credentials and read the response's cookies. A browser-only sign-in would leave the scorer nothing to drive.

## The claim is measured behaviorally

`a tampered session cookie does not get the dashboard` signs a user in through the app, re-encodes the session with a second user's identity, and leaves the signature alone so the token no longer verifies. Reading stored session state accepts that cookie. Verifying the token rejects it.

`server code verifies the token rather than trusting stored session state` is the source-level companion. It accepts `getClaims()` and `getUser()` both, and names the class rather than the method, so it survives the page changing its recommendation.

## Do not drop the positive controls

`a tampered session cookie does not get the dashboard` passes for an app that renders nothing at all, so it is gated on `the dashboard renders the signed-in viewer email` passing first. Drop that gate and an app that never worked scores full marks on the eval's central claim.

`no deprecated auth-helpers import` passes for an agent that wrote no code. The build and the render control are what make it mean something.

## The runtime checks install and build in the sandbox

`next` is not a dependency of the framework, and the host-side build helpers relink the workspace's `node_modules` to the framework's own, so a host-side build cannot see what the seed declared. `ctx.exec` runs the install, the build, and the server inside the sandbox instead.

`project dependencies installed` and `the app builds` are separate checks so an install or build failure costs the three runtime checks and nothing else. Neither is evidence about the guide.

## The guide has to actually be read

`the agent read the server-side client guide the prompt referenced` matches docs calls against the guide's path. Without it, a run that never opened the page and passed on prior knowledge would read as the guide working.

It resolves the url from the harness's own docs result rather than the raw tool call, because a `search_docs` hit carries the guide's url in its result rather than its request.

## What this eval does not score

**Which auth method the login form uses.** The prompt says people log in and does not say how.

**Redirect loops.** Reproducing one needs a protected-route matcher the prompt does not ask for.

**Refresh-token reuse under concurrency.** `the viewer stays signed in across two page loads` covers the sequential case. The concurrent case needs parallel requests mid-refresh and would be flaky.

**Whether the proxy or the page does the protecting.** Either is acceptable, as long as the tampered cookie fails.

**A session cookie split across chunks.** The tamper reassembles a single cookie. If a session arrives chunked, the check reports that it was not measured rather than passing.

**Row level security and grants.** No table is seeded. Access control is `build-docs-002-rls-guide`.

**Which key format reaches the client.** That is `build-docs-003-api-keys-guide`.
