# build-docs-041-send-email-hook

## What this eval measures

The subject is [Send Email Hook](https://supabase.com/docs/guides/auth/auth-hooks/send-email-hook), not the agent. The
prompt is a product request plus the page's url, and the checks say whether an agent that read the page hands Auth's
emails to the team's own mail queue.

One claim: Auth puts the sign-up and password reset emails in the team's outbox as finished emails, their buttons work,
and only Auth can put mail there.

`build-docs-021-email-templates` also follows a sign-up button, but there Auth sends the email itself and the agent
changes its wording. Here Auth sends nothing. The agent writes the code that builds the email and its link from what
Auth hands over, and lets Auth's database role write to a table it does not own.

## Do not reintroduce the vocabulary

Keep all of these out of `PROMPT.md`:

hook, auth hook, send email hook, Postgres function, database function, HTTP endpoint, Edge Function, webhook,
`config.toml`, `[auth.hook.send_email]`, `pg-functions`, `uri`, `secrets`, `supabase_auth_admin`, grant, revoke,
execute, permission, privilege, role, anon, authenticated, security definer, RLS, row level security, policy, token,
`token_hash`, `email_action_type`, `redirect_to`, `site_url`, verify, confirmation url, SMTP, email provider, template,
payload, event.

"Outbox", "button" and "the page the app asks for" stay, because that's how the team would say it.

## The seed carries the contract

- `local/MAIL.md` and the init migration fix the outbox: `public.outbox` with `to_email`, `subject` and `html`. The
  worker sends a row as it is, so the row has to carry a working link. The scorer reads the outbox, so the end state is
  observable without a mail provider.
- The outbox has row level security on, no policies, and no grants to `anon` or `authenticated`. Row level security on
  the table is a seed choice. It matches what the Table Editor and the Security Advisor default to for a table in
  `public`. A hook that writes to such a table needs a rule that lets Auth's database role write to it. Reading is
  closed by the seed, so the access check measures what the agent opens up.
- `local/src/account.ts` asks for the reset with `redirectTo` set to `/account/new-password`. That page is where the
  reset button has to land. `config.toml` allows `http://127.0.0.1:3000/**` as a redirect.
- `config.toml` is the `supabase init` default with `enable_confirmations = true`, as on a hosted project, so sign-up
  sends an email. That setting is pre-solved here. `email_sent` is 100.
- `services` leaves out Mailpit and the edge runtime. With Mailpit off, an email Auth still tries to send itself fails
  the request. The queue is in the database, so the edge runtime is not needed, and an HTTP endpoint is not scored.

## Do not drop the positive controls

The access check passes for a project that built nothing. The three checks before it make it mean something, because
they need a row that Auth wrote. The sign-up and reset addresses are scoped to the run, so a fixed address in the
project matches nothing.

## How the checks read the end state

- The scorer waits for Auth's health endpoint, signs up a new person through the API, and asks for a password reset for
  a second, confirmed person. It reads the outbox rows addressed to each and the token hashes Auth stored for each.
- A button is any link in the row's `html` that points at Auth's verify endpoint with a token, or carries the stored
  token hash under any query parameter, or has a `token_hash` parameter. Every such link is followed, and the button
  works if any one does. A link is followed only on `127.0.0.1` or `localhost`.
- A token hash link is redeemed the way an app route would. The scorer tries the link's `type`, then `email`, then
  `recovery`, so a link with no `type` passes.
- The reset button passes when Auth redirects to the `/account/new-password` path with a session. A token hash link
  passes when Auth returns a session and the link, or one of its parameters, names that path. A query on the page is
  ignored.
- The access check runs as `anon` and as `authenticated` in a transaction it rolls back. It proves four things:
  - No table or view in the exposed schemas shows them a row the scorer put in the outbox.
  - A direct insert into the outbox adds no row.
  - Calling each function in the exposed schemas that takes one `json` or `jsonb` argument, with an event shaped like
    Auth's, adds no row. A call that raises any error and leaves the outbox unchanged passes, so a guard on the caller
    passes.
  - They can run no function in the exposed schemas that runs as its owner and whose body names the outbox.

  A read that fails with an error other than `42501` fails the check as could not tell.

## What the access check does not catch

- A function that writes to another table that a job later copies into the outbox.
- A function that runs as its owner and builds the outbox's name at runtime.
- A function that runs as the caller, takes other arguments, and writes through a rule the agent added for app users
  that a plain insert does not satisfy.
- Schemas outside the exposed list in `config.toml`.

## Order of the scorer

The scorer restarts the stack first, because Auth reads its settings when its container starts. The harness adds the
eval's service excludes to `start`. It then applies pending migrations with `supabase migration up --local`, which
writes to the database, so score once per stack. The access check runs last.

## The guide has to actually be read

`the agent read the send email hook guide the prompt referenced` requires a docs call that reached the page with
content. Read `docs.calls` before reading a score.

## Checks expected to saturate

The stack check and the migration check. The access check saturates unless the agent writes a function that runs as
its owner and leaves it open to app users. The signal is expected in the sign-up row, which needs Auth's role let into
the outbox, and in the two button checks.

## What this eval does not score

- **The other emails.** Only sign-up and password reset are probed. Magic link, invite, email change and the
  notifications are not.
- **An HTTP endpoint.** The edge runtime is not started, so signature checks and secret formats are not scored.
- **The email's wording.** Only the address and the links are read.
- **What a failing send does.** The prompt does not say whether a failed queue write should block sign-up.
- **Hosted projects.** The dashboard settings need a hosted project.
