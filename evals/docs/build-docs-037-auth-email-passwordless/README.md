# build-docs-037-auth-email-passwordless

## What this eval measures

The subject is [Passwordless email sign-in](https://supabase.com/docs/guides/auth/auth-email-passwordless), not the
agent. The prompt is a product request plus the page's url, and the checks say whether an agent that read the page makes
email sign-in work by a typed code.

One claim: every sign-in email carries a 6-digit code and no sign-in link, for a returning person and for someone signing
in for the first time, and the code signs them in.

## Do not reintroduce the vocabulary

Keep all of these out of `PROMPT.md`:

magic link, OTP, one-time password, token, `{{ .Token }}`, `{{ .ConfirmationURL }}`, `{{ .TokenHash }}`, template, email
template, confirm signup, confirmation, `enable_confirmations`, `config.toml`, `content_path`, `signInWithOtp`,
`verifyOtp`, `shouldCreateUser`, sign up, Mailpit.

"Code", "link" and "the very first time" stay, because that's how the team would say it.

## The seed carries the contract

- `local/src/sign-in.ts` is the app's two steps. It asks Auth to email the person, creating them if they are new, then
  checks the code with type `email`. The scorer makes the same two requests.
- `config.toml` is the `supabase init` default with `enable_confirmations = true`, as on a hosted project, and
  `email_sent` raised to 100. With confirmations on, a first-time person gets the sign-up email, not the sign-in one. A
  project that changes only the sign-in email still sends new people a link. Turning confirmations off also gets them a
  code, and it passes.
- The pinned CLI's standard emails carry a link and no code, so a project that changes nothing fails every email check.

## Do not drop the positive controls

- Each "no sign-in link" check passes for an email with nothing in it. The code check and the sign-in check for the same
  person make it mean something.
- The code is the 6-digit run in the subject, body or links whose SHA-224 with the address matches the hash Auth stored
  for that person. Any other digits are not the code. The code check requires the code outside every url, and the
  scorer sends only that code to Auth and requires a session back.
- A sign-in link is any url in the email that points at Auth's verify endpoint, or carries the code or the stored hash. A
  link through the app's own route counts, because whoever opens it first spends it.
- Both addresses are scoped to the run and carry no digits, so a fixed address in the project matches nothing.

## The scorer restarts the stack

Auth reads its email settings when its container is created, so the scorer runs `supabase stop` then `supabase start`.
The harness adds the eval's service excludes to `start`. The scorer sends one email to each of two addresses, so
`max_frequency` does not drop either.

## The guide has to actually be read

`the agent read the passwordless email guide the prompt referenced` requires a docs call that reached the page with
content. Read `docs.calls` before reading a score.

## Checks expected to saturate

The stack check and the three returning-person checks. The signal is expected in the three first-time-person checks.

## What this eval does not score

- **The client code.** The client is seeded, so client code is not scored, including any edit an agent makes to it.
- **Sign-in by link.** The prompt rules links out, so sign-in by link is not scored.
- **Who may join.** The prompt says anyone can, so turning off new accounts is not tested.
- **Code expiry and request limits.** The prompt names neither.
- **Code length beyond the 6 digits the screen takes.** An 8-digit code fails the code checks, and nothing else about
  length is scored.
- **The wording of the email.** Only the code and the absence of a link are read.
- **Hosted projects.** The dashboard settings and plan limits on editing emails need a hosted project.
