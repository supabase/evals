# What this eval measures

The subject under test is the [API keys guide](https://supabase.com/docs/guides/getting-started/api-keys), not the agent. A gap in the guide counts as a failure.

## Do not reintroduce the vocabulary

`PROMPT.md` never says key, publishable, secret, service role, server, expose, or environment variable. Stripping it is the measurement.

The task is deliberately vague and the method deliberately is not. The prompt tells the agent to rely on the guide rather than on what it already knows, so a pass is evidence about the page instead of about the model's priors. Keep that instruction when loosening the rest.

## The roster is the pressure point

- **Sign-up.** Public, and correct with a publishable key. It never forces a choice.
- **Roster.** Needs everyone's email, which lives in `auth.users`. No publishable key reaches it.

**The address is not published.** The sign-up form says it is only used to sign you in, and the prompt asks for a list the person building the app can see. Neither states a rule, so working out that a public directory of addresses contradicts them is part of the measurement. That inference is the ground `no client role can read another user's email` stands on.

**`profiles` is pre-solved.** RLS, policies, and grants ship with the seed. Policy design is what `build-docs-002-rls-guide` measures, and a grant mistake here would fail this eval for the wrong reason.

## Do not drop the positive controls

`no secret key in the client bundle` and `secret key absent from client source` both pass for an agent that built nothing.

`roster returns every signed-up email` and `client source calls signUp` are what make them mean something. The `no-roster`, `unused-client`, `no-client`, and `broken-build` solutions hold that pairing in place.

## The seed names the endpoint

`src/App.tsx` points the roster at `GET /functions/v1/roster`. That costs the question of whether an agent reaches for a server unprompted, and buys a positive control the scorer can prove. The contract sits in a seed comment so `PROMPT.md` keeps its vocabulary.

## The guide has to actually be read

`the agent read the API keys guide the prompt referenced` matches docs calls against the guide's path. Without it, a run that never opened the page and passed on prior knowledge would read as the guide working.

It resolves the url from the harness's own docs result rather than the raw tool call, because a `search_docs` hit carries the guide's url in its result rather than its request.

## Expect the env var check to fail

The guide recommends no environment variable convention. No `NEXT_PUBLIC_`, no `VITE_`.

A solution written from the page can pass every bundle check and still expose the secret through a client-visible name. That is a finding about the guide, tracked in [DOCS-1311](https://linear.app/supabase/issue/DOCS-1311/improve-api-keys-documentation-based-on-eval-findings), not a scorer defect.
