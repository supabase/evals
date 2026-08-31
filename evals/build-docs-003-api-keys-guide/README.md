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

`roster returns every signed-up email` and `client source calls signUp` are what make them mean something. Drop either one and a run that produced nothing scores full marks.

## The seed names the endpoint

`src/App.tsx` points the roster at `GET /functions/v1/roster`. That costs the question of whether an agent reaches for a server unprompted, and buys a positive control the scorer can prove. The contract sits in a seed comment so `PROMPT.md` keeps its vocabulary.

## The guide has to actually be read

`the agent read the API keys guide the prompt referenced` matches docs calls against the guide's path. Without it, a run that never opened the page and passed on prior knowledge would read as the guide working.

It resolves the url from the harness's own docs result rather than the raw tool call, because a `search_docs` hit carries the guide's url in its result rather than its request.

## The client has to use the new key format

`client uses a publishable key, not the legacy anon key` fails when the legacy anon key ships to the browser, including when both keys ship. A bundle carrying neither fails it too, since the claim is then unproven.

It sits alongside `client bundle carries a publishable or anon key` rather than replacing it. That one is the control on whether the client reaches the project at all, and a run that picked the legacy key still has to prove the sign-up screen works.

## The server has to use the new key format too

`server reads no legacy key variable` fails when anything under `supabase/functions` references `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_ANON_KEY`. Those are the slots the runtime fills with a legacy key, so reading one puts a deprecated credential on the server even though nothing was written down in the repo.

**It is a source scan, and the name says so.** Both key formats map to the same Postgres role, so once a request arrives no probe can tell which one authenticated it. The source is the only place the difference shows.

**A missing server fails it.** No code under `supabase/functions` means nothing proves the claim, matching how a failed build is handled rather than greening out a run that built no server.

### A server that passes

The runtime injects `SUPABASE_SECRET_KEYS`, a JSON map whose `default` entry holds an `sb_secret_` key, alongside the legacy `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`. Reading the new-format map is what a passing function does:

```ts
const secretKey = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')!).default;
const admin = createClient(Deno.env.get('SUPABASE_URL')!, secretKey);
await admin.auth.admin.listUsers();
```

A function that supplies its own credential passes too, reading a secret key it holds under its own name in `supabase/functions/.env`. No other check objects to either shape. The client-source and bundle scans exclude `supabase/`, and the env var check only reads prefixes Vite inlines.

**`cliVersion` in `PROMPT.md` decides which keys reach a function.** Only a CLI that injects `SUPABASE_SECRET_KEYS` gives a function a new-format key without one being written down. Re-read this section when that pin moves.

## The env var check is a guard

`no secret-bearing env var is client-exposed` passes when the secret is kept out of the client env, including when there is no env var at all. It fails only on a secret sitting behind a name Vite inlines, and it reads the inlined prefixes off `vite.config.ts` so a renamed `envPrefix` stays in range.

It duplicates the dist scan on purpose. A secret in the client env is a leak whether or not the build under score inlined it.

## The roster probe calls as a signed-in user

`roster returns every signed-up email` sends the fixture user's access token, so a roster gated on being signed in still counts as working. A roster open to anyone answers that request too.

Who may see the roster is out of scope. `PROMPT.md` does not say, and restricting the endpoint to staff needs a role in the seed, which is what `build-rls-003-org-roles-permissions` measures.
