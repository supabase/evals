# What this eval measures

The subject under test is the [Password-based Auth guide](https://supabase.com/docs/guides/auth/passwords), not the agent. A gap in the guide counts as a failure.

The claim is **weak passwords are refused**. The user gives a policy in product words, at least 12 characters with a lowercase letter, an uppercase letter, a digit and a symbol, and wants it to hold for everyone, including anyone who skips the app and calls the backend. The scorer restarts the local stack, signs people up directly through Auth with a set of passwords, and reads back who got in.

## Confirming the claim

The ticket's claim is a reading of the page, and the page does not carry it. I fetched `passwords.md` and searched it for strength, minimum, length, requirement, leaked, weak and pwned. There are no hits. The only gesture is one sentence in the intro, "using secure configuration options and best practices". Its related resources list is a single web block, and it does not link to the page that does cover this.

That page is [Password security](https://supabase.com/docs/guides/auth/password-security). It says to set a minimum length of at least 8, to require digits, lowercase and uppercase letters and symbols, and to turn on leaked password protection. It also says an existing user whose password falls short hits a `WeakPasswordError` on sign-in.

So an agent that reads only the page the prompt references learns how to call `signUp()` and nothing about refusing weak passwords. A solution written from that page alone, a working sign-up with no settings changed, fails both refusal checks below. That failure is the finding for the docs ticket. Whether agents find the other page on their own, or already know the two settings, is what a baseline will say. Read `docs.calls` for which pages were opened before reading the score.

What I could and could not confirm:

- **Confirmed:** the page text, as above. The error shape: `@supabase/auth-js` 2.108.1 types a weak password as error code `weak_password` with reasons `length`, `characters` or `pwned`. The two settings exist in a seed `config.toml` as `minimum_password_length = 6` and `password_requirements = ""`, which are the defaults.
- **Not confirmed, no stack here:** that Auth enforces them as I model them, the values `password_requirements` accepts, and the HTTP status of a refusal. The checks key on the error code, not the status. The values come from memory of the CLI's config template: `letters_digits`, `lower_upper_letters_digits` and `lower_upper_letters_digits_symbols`.

The evidence the ticket cites, supabase/agent-skills#627, is about leaked password protection: an agent sent a user to a dashboard section that did not exist, for a setting that needs the Pro plan. That setting is hosted-only and plan-gated, so a local check cannot measure it. It is not scored.

## Existing coverage

Nothing signs people up and checks which passwords get in.

- `deploy-auth-001-push-config-change` asks an agent to raise the minimum to 10 characters and push it to a hosted project. It measures the `config push` mechanics, needs no docs page, and never signs anyone up. It does not cover character requirements.
- `build-docs-005-server-side-auth` and `build-docs-010-edge-function-auth` sign users up with a password, as a step towards something else, and neither probes which passwords get in.
- `build-docs-018-redirect-urls` is the same shape as this eval, an Auth setting in `config.toml` that the scorer applies by restarting the stack, and its restart is reused here.

## Do not reintroduce the vocabulary

`PROMPT.md` never says minimum length, password strength, password requirements, required characters, weak, leaked, pwned, HaveIBeenPwned, `config.toml` or `password_requirements`.

It does state the policy: 12 characters and the four kinds. That is deliberate. "Weak" needs a definition the scorer can test, and the policy is what a product owner would say. It names no mechanism. Stripping the mechanism is the measurement. The prompt tells the agent to rely on the guide rather than on what it already knows, so a pass is evidence about the page. Keep that instruction when loosening the rest.

## The seed carries nothing but the default project

`supabase/config.toml` is the `supabase init` default, with the Auth section as it ships. There is no app. With no app there is nowhere for client-side validation to land, so the only way to meet "everyone, including the backend directly" is the project's own settings. The answer lives somewhere a scorer can reach, the file and the running Auth.

Where the contract lives is a choice and this one is deliberate: the prompt gives the policy and the seed gives no hint where it goes, so the discovery question is part of what is measured.

## The fixtures

Every refused password breaks exactly one rule, so a project that enforces only one of the two cannot pass both checks.

- **Too short:** 11 characters and 8 characters, each with every kind of character.
- **Missing a kind:** 15 characters each, with no symbol, no digit, no uppercase letter, and no lowercase letter.
- **Accepted:** 12 characters, which is the shortest the policy allows, and two 16 character passwords with different symbols.

The boundary is on purpose. A memorized answer of 8, which the password security page names as the floor, or 10, which `deploy-auth-001` uses, lets the 11 character password in. A minimum of 13 or more refuses the 12 character one.

## The scorer restarts the stack

Auth reads its settings when its container is created, so the scorer runs `supabase stop` then `supabase start` inside the sandbox, whether or not the agent restarted it. The harness wrapper adds the eval's service excludes to `start`. An invalid value in the config fails here, which costs `the local stack starts with the project settings` and reports the rest as `not run`.

## Do not drop the positive controls

An agent that built nothing refuses nothing, and a project that refuses every sign-up refuses everything. `passwords that meet the policy are accepted` is what separates a policy from a wall, and it fails a minimum length of 13 or more. Drop it and a project that turns every sign-up away scores full marks on the other two.

## The probes refuse for one reason only

A refusal counts only when Auth answers with the error code `weak_password` and the user does not exist afterwards. The user's presence is read from `auth.users` as the superuser, so a status code is never trusted. Any other error, a rate limit or a rejected email for example, is `could not measure` and fails, because it says nothing about the policy.

## What each check proves

| Check | Proves |
| --- | --- |
| `the local stack starts with the project settings` | The project's settings are valid and the stack comes up on them. |
| `a password shorter than 12 characters is refused` | The minimum length is at least 12. |
| `a password missing a kind of character is refused` | All four kinds are required. A project that requires only letters and digits, or lower and upper case without a symbol, fails here. |
| `passwords that meet the policy are accepted` | The policy is not stricter than asked, and sign-up still works. |
| `the agent read the passwords guide the prompt referenced` | The page was opened with content. |

The three probe checks share one round of sign-ups, so they cost one restart.

## Predictions, and what the probes were run against

The probe code ran against a fake Auth server with a configurable policy, backed by PGlite for `auth.users`, through a stub `supabase`. The fake is my model of how Auth treats the two settings. It tests the scorer's logic and not Auth's behavior. Predictions were written first and all 12 held.

| Policy the project ends up with | Red |
| --- | --- |
| Minimum 12, all four kinds required | none |
| Defaults, nothing changed | short, characters |
| Minimum 12, no character rule | characters |
| Minimum 6, all four kinds | short |
| Minimum 8, all four kinds | short |
| Minimum 10, all four kinds | short |
| Minimum 14, all four kinds | accepted |
| Minimum 12, letters and digits only | characters |
| Minimum 12, upper, lower and digits | characters |
| Minimum 100, all four kinds | accepted |
| Invalid value, the stack will not start | everything |
| Rate limited on every call | short, characters, accepted |

## The guide has to actually be read

`the agent read the passwords guide the prompt referenced` matches docs calls against the guide's path. It does not require the password security page, because the prompt never points there. If the baseline shows agents passing without ever opening it, that is the finding.

## What this eval does not score

- **Leaked password protection.** Hosted only, Pro plan and above, so a local stack cannot show it. It is what supabase/agent-skills#627 is about.
- **Updating a password.** The same policy applies through `updateUser`, but the scorer only signs up.
- **Existing users.** The password security FAQ says they can still sign in until they next change their password, and then see `WeakPasswordError`. That needs a user created before the policy.
- **Reauthentication and current password on change.** Separate settings on the other page.
- **Phone sign-ups, and email confirmation.** The seed leaves confirmation off, which is the local default. If an agent turns it on, a third sign-up can hit the email rate limit and report `could not measure`.
- **A policy enforced outside Auth's settings.** The prompt asks for everyone, including the backend directly, so the policy has to live in Auth. An agent that sets `enable_signup = false` and sends sign-ups through its own server code gets `signup_disabled` from the scorer's direct sign-ups. The two refusal checks then report `could not measure` and `passwords that meet the policy are accepted` fails. That is intended.
- **Pushing the settings to a hosted project.** The prompt asks for the local project, and `auth.password_requirements` is reported not to sync through `config push` (supabase/cli#3148).
- **How the password is stored.** Not something an agent builds.

## Risks

- **Not run against a real stack.** The scorer assumes Auth answers a refused sign-up with `error_code: weak_password`, that `supabase status` reports a `PUBLISHABLE_KEY` or `ANON_KEY` the sandbox can use, and that `supabase stop` then `start` brings Auth back up on the new settings. The restart is what eval 018 does. The rest is what a first run settles.
- **The accepted passwords could trip a pwned check.** None of the three is a common password, and as far as I know the local stack does not turn leaked password protection on by default, so I expect none to. Not verified.
- **Refresh twice before describing how agents fail.** One baseline's failure mode is not the eval's.
