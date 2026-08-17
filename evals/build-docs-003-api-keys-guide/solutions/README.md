# Example solutions

What the scorer should say about each, written down before any of them was scored.

Every solution here overlays the eval's `local/` workspace. The keys in each `.env` are the Supabase CLI's well-known local development values, so they match whatever `supabase status` reports inside the sandbox.

| Solution               | Expected result                                                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `green`                | Every check passes.                                                                                                                                                                                             |
| `secret-in-client`     | Fails `no secret key in the client bundle` and `secret key absent from client source`. Also fails `roster returns every signed-up email`, since the lookup moved into the browser and no function was deployed. |
| `vite-prefixed-secret` | Fails `no secret-bearing env var is client-exposed` and `no secret key in the client bundle`. The roster still works, so its check passes.                                                                      |
| `no-roster`            | Fails only `roster returns every signed-up email`.                                                                                                                                                              |
| `unused-client`        | Fails `client source calls signUp` and `roster returns every signed-up email`.                                                                                                                  |
| `legacy-anon-key`      | Every check passes. The guide says the legacy anon key serves the same purpose, so using it is not a flaw.                                                                                       |
| `broken-build`         | Fails `vite build passed`. `client bundle carries a publishable or anon key` and `no secret key in the client bundle` report not run rather than passing.                                        |
| `no-client`            | Fails `client bundle carries a publishable or anon key`, `client source calls signUp`, and `roster returns every signed-up email`.                                                               |

`emails-in-profiles` dodges the elevated call entirely by copying addresses into a table anyone can read. Every key check passes and the roster works, so without its own check it scores a clean sheet.

`unused-client` is the counterpart to `no-roster` for the other screen. It creates a real client and ships the publishable key, so `client bundle carries the publishable key` passes, but the form never calls `signUp`. Without its own check, a bundle carrying an unused key reads as a wired sign-up page.

`vite-prefixed-secret` passes `secret key absent from client source` on purpose. Its client code reads the key from an environment variable rather than writing it down, so the source scan is clean and the bundle and env var checks are what catch it.

## Why `broken-build`, `no-client`, and `legacy-anon-key` are here

None of them is a security mistake. Each exists because a check had nothing exercising it.

- `broken-build` is the only solution that fails the build, so it is the only one that runs the not-run path on the two bundle checks.
- `no-client` is the only one where no key reaches the browser at all, so it is the only one that fails `client bundle carries a publishable or anon key`.
- `legacy-anon-key` is a green solution that uses the legacy key. It guards against the check being narrowed back to the publishable key alone, which would red a solution that followed the page.

## Why `no-roster` is here

It is the solution that does the least, and it passes every bundle and source check. `no secret key in the client bundle` is trivially true when no elevated call was ever written.

If a future change drops `roster returns every signed-up email` as redundant, this solution scores a clean sheet and the eval stops measuring anything. That is what it is here to catch.

## Why `secret-in-client` fails three checks, not one

One flaw usually trips several checks. Moving the lookup into the browser leaks the key into the bundle, leaves it in committed source, and removes the server surface the roster probe calls. Matching this list is the bar, not one failure per solution.

## Checks that read the agent's transcript

One. `the agent read the API keys guide the prompt referenced` inspects the docs calls an agent made, so it fails on every solution here by construction. Nobody ran an agent.

Read the scores as `n/9` with that one always red. Everything else is scorable without an agent run.
