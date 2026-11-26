# build-docs-039-auth-mfa

## What this eval measures

The subject is [Multi-Factor Authentication](https://supabase.com/docs/guides/auth/auth-mfa), not the agent. The prompt
is a product request plus the page's url, and the checks say whether an agent that read the page locks data behind a
second step only for the people who turned one on.

One claim: once someone turns on an authenticator code, their rows open only after they type it, on every device, and
everyone without a code keeps working with a password.

The eval expects a rule that answers every request. Signed-in users cannot read `auth.mfa_factors`, so the rule has to
learn whether someone has a code without reading that table as the user. A rule that tries fails every request with
`42501 permission denied for table mfa_factors`, and the controls catch it.

## Do not reintroduce the vocabulary

The prompt keeps "authenticator app", because a user has no other name for it. Keep all of these out of `PROMPT.md`:

MFA, multi-factor, two-factor, 2FA, second factor, factor, TOTP, enroll, verify, challenge, AAL, aal1, aal2, assurance
level, JWT, claim, token, session, refresh, restrictive, permissive, policy, RLS, row level security, mfa_factors,
security definer, authenticated, config.toml, `[auth.mfa.totp]`, enroll_enabled, verify_enabled.

## The seed carries the contract

`local/supabase/migrations/20240101000000_init.sql` is a journal app with two tables. Three things in the seed are
load-bearing.

- **Both tables already have a permissive rule for their owner.** A second permissive rule that asks for the code
  changes nothing, because rules of that kind combine with OR. Only a rule required in addition, or a rewrite of the
  existing ones, passes.
- **Two tables, not one.** Every probe reads and writes both, so a rule on one table does not pass.
- **`[auth.mfa.totp]` is off in `local/supabase/config.toml`**, as `supabase init` writes it.

`enable_confirmations = false` lets the scorer sign people up without a mailbox.

The prompt says which rule applies to people without a code: they keep working. It also says someone who gave up
halfway has not turned the code on, and that a device signed in before the code was turned on is locked too. Each of
those has its own check.

## Codes are scored once, then turned on

`the project lets people turn on an authenticator-app code` runs on the agent's own `config.toml`. The scorer signs up a
person, sets up a code and types it. That check reflects the pinned CLI's local default, which has codes off. Hosted
projects have them on.

If the check fails, the scorer sets `enroll_enabled = true` and `verify_enabled = true` under `[auth.mfa.totp]` in the
workspace's `config.toml` and restarts the stack. Every other check then measures the agent's rules, not the switch.
The scorer restores nothing afterwards, so score once per stack.

## Do not drop the positive controls

The refusal checks pass for a project where nobody can read or change anything. The controls stop that:

- `someone without a code reads their journal with a password` and `someone without a code adds, changes and removes
  journal rows with a password` fail a rule that locks everyone, or one that blocks changes for everyone.
- `a person who typed their code reads their journal` and `a person who typed their code adds, changes and removes
  journal rows` fail a rule that locks the code holder for good.
- `a device signed in before the code was turned on is locked once it is on` first reads the rows from that device
  before the code is turned on. If that read fails, the check reports could-not-measure.

The refusal checks count rows as the superuser. An insert must write nothing, and an update or delete must leave the
seeded row as it was. Any error is accepted as a refusal once the superuser read confirms that, so a trigger that raises
its own error passes. The skipped-code reads pass on an empty result or any error.

Every person and row is made by the scorer after the agent's work, with names scoped to the run. The scorer types the
code itself, computed from the secret it gets back when it sets the code up.

## Order of the scorer

The scorer restarts the stack first, so Auth runs on the project's `config.toml` whether or not the agent restarted it.
Restarting needs the services in `services:`, so a harness that starts every service also passes. It then applies
pending migrations with `supabase migration up --local`, which writes to the database. Then it probes codes, and turns
them on and restarts if needed.

When the scorer cannot set up a code even after turning codes on, every check about a code holder reports `not run`
with the reason. The skipped-code writes run last, because a write that gets through would change rows the other probes
read.

## The guide has to actually be read

`the agent read the multi-factor authentication guide the prompt referenced` requires a docs call that reached the page
with content. A read of the TOTP or phone page alone does not count. Read `docs.calls` before reading a score.

## Checks expected to saturate

The restart, the migration check, and the two skipped-code refusals. A rule that refuses every request passes both
refusals. The device signed in before carries the same token level as a fresh password sign-in, so it moves with the
skipped-code reads. Only a rule that reads whether someone has a code from the token, such as a claim added at sign-in,
separates the two. The signal is expected in the code check and the five controls.

## What this eval does not score

- **Screens and client code.** No client is seeded, so the scorer runs the sign-in and code steps itself.
- **Removing a code.** The prompt does not ask for it.
- **Phone codes.** The prompt asks for an authenticator app only.
- **Functions that bypass the rules.** A function that runs as its owner skips row rules. The seed has none, and the
  prompt does not ask for one.
- **Anyone who is not signed in.** The seed grants them nothing.
- **How the agent applied its change.** Any route that leaves it applied passes.
