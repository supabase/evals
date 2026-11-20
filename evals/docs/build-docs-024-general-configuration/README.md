# build-docs-024-general-configuration

## What this eval measures

The [General configuration](https://supabase.com/docs/guides/auth/general-configuration) guide, not the
agent. The agent gets a closed beta and a product request: nobody new gets an account, and everyone who
already has one keeps it. If an agent that read the page locks out existing people, or leaves sign-ups
open, the page didn't carry it.

The ticket also named sessions. The page only links to the Sessions settings, so they aren't scored.

## Do not reintroduce the vocabulary

The prompt leaves these out on purpose: "Allow new users to sign up", enable_signup, confirm,
confirmation, verify, email_confirmed_at, autoconfirm, admin, auth.users, invite-only, config.toml.

"Make an account", "log in" and "the link in their welcome email" stay, because that's how the team
would say it.

## Two switches that look alike

`[auth] enable_signup` is the page's "Allow new users to sign up". `[auth.email] enable_signup` turns
off the whole email provider, so existing people can't log in either. The seed config carries no
comments, so the page is the only thing telling them apart.

Turning confirmations off only confirms people when they sign up. Anyone who signed up before stays
unconfirmed and keeps getting "Email not confirmed", and with sign-ups closed they can't sign up again
to fix it. The page says the setting "implicitly confirms the user's email in the database", which
reads as if it fixes them too.

## The seed carries the contract

- `TESTERS.md` lists the four testers and their plots.
- `supabase/seed.sql` creates six accounts with fixed ids and the password `fernhill-beta`: two testers
  who confirmed, two who didn't, and two strangers from the old sign-up page who didn't.
- `supabase/migrations/` adds `plots`, which point at the testers' accounts. That's why "keep the
  accounts they have" is checked by id.
- `config.toml` is the `supabase init` default with confirmations on, as the beta ran.

The scorer restarts the stack (`supabase stop` keeps the data), so a fix made in the database counts
as long as it's in the running database. Editing `seed.sql` alone doesn't count until it's applied.

## Do not drop the positive controls

- "a new email can't create an account" passes when email logins are off entirely.
  "testers who confirmed can still log in with their password" is what makes it mean something.
- "people who aren't testers still can't get in" passes when nothing changed.
  "testers who never confirmed can log in, as the same account" is the other half: confirming every
  account passes that one and fails this one.
- Mailpit runs so an open sign-up really creates the account. Without it, Auth can't send the welcome
  email, rolls the sign-up back and returns a 500.
- Refused means a 4xx that isn't a 429, **and** the email isn't in `auth.users` afterwards. The reply
  alone isn't trusted.

## The guide has to actually be read

"the agent read the general configuration guide the prompt referenced" fails unless a docs call
returned the page's content. Read `docs.calls` before the score.

## What this eval does not score

- **Sessions.** The page only links out to them.
- **Whether confirmations end up on or off.** With sign-ups closed it doesn't change who gets in.
- **How the testers get in.** SQL, the admin API, or an applied seed all work. The page doesn't teach a
  method, so the check is that they log in as the same account.
- **Anonymous sign-ins, OAuth and manual linking.** Off in the seed and not in the prompt.
- **The team adding people later.** Admin-created accounts aren't affected by the setting, so it can't fail.
- **Signing up twice with the same email.** A separate claim.
- **The hosted dashboard.** The prompt asks for the local project.
