# build-docs-021-email-templates

## What this eval measures

The [Email Templates](https://supabase.com/docs/guides/auth/auth-email-templates) guide, not the agent. The
agent gets the wording for the sign-up email and a product request: send it when someone signs up, greet them by
the nickname they typed, and keep every other email as it is. If an agent that read the page leaves a project
that sends nothing, sends the default, or sends a button that doesn't confirm anyone, the page didn't carry it.

The scorer signs up a new person against the local stack, reads the message in Mailpit, follows the button, and
reads back whether Auth confirmed the user.

## Do not reintroduce the vocabulary

The prompt leaves these out on purpose: email template, template, `config.toml`, `content_path`,
`ConfirmationURL`, `TokenHash`, `{{ .Data }}`, `enable_confirmations`, Mailpit, Go template, subject line key.

"Sign-up email", "nickname" and "button" stay, because that's how the team would say it.

## The seed carries the contract

- `EMAIL_COPY.md` fixes the subject, heading, message and button label, and the "Hi" that opens the message.
  The scorer matches them exactly and is case sensitive, so the words are not for the agent to improve. Text in
  `<head>` doesn't count. The rule that the email has no code is scored as no run of six to eight digits.
- `src/sign-up.ts` is the only place the metadata key (`nickname`) appears. The agent has to find it there. A
  memorized `first_name` renders as `<no value>` and fails.
- `config.toml` is the `supabase init` default, with two differences: `email_sent` is 100 instead of 2, so an
  agent testing its own sign-ups can't use up the scorer's budget. Confirmations stay off, which is the default.
- There is no app server in the seed. A button has to reach Auth, either through the confirmation link or by a
  token the scorer can hand to Auth the way a server route would.

## Do not drop the positive controls

- "other emails are still the standard ones" passes for an agent that built nothing. The five checks before it
  are what make it mean something. It reads two other emails, the password reset and the magic link, and fails an
  agent that pointed either at the new copy or changed its subject. Their standard subjects are pinned in
  `probes.ts` to what the pinned CLI sends, so a CLI upgrade that renames a default subject shows up here first.
- "signing up sends an email to the new user" is the one a page-only reader misses. Confirmations are off in the
  default project, so a project with the right template and no change to that setting sends nothing. The page
  and the local customizing guide it links to don't say so. Only the testing guide, which the page links to for
  Mailpit, does. An agent that stops at the page and the customizing guide fails here.
- "the button ... confirms the person" follows the link rather than reading it. A link that renders, points at
  Auth and carries no token, or builds the address from the Site URL by hand, all fail here and pass a read.
  The scorer also accepts a link that carries the token hash and type to an app route, because the page
  recommends that pattern. It confirms the token the way such a route would.
- The nickname is run-scoped, so a name typed into the template passes nothing.

## The scorer restarts the stack

Auth reads the template settings when its container is created, so the scorer runs `supabase stop` then
`supabase start` inside the sandbox. The harness wrapper adds the eval's service excludes to `start`. Mailpit is
one of the three services the eval starts.

## The guide has to actually be read

"the agent read the email templates guide the prompt referenced" fails unless a docs call returned the page's
content. Read `docs.calls` before the score.

## What this eval does not score

- **Hosted projects.** The dashboard, the Management API block and the free-tier limit on editing templates need
  a hosted project. The prompt asks for the local project.
- **The other templates.** Only the password reset and magic link emails are read. The invite, email change,
  reauthentication and the seven security notifications are not, and neither are their variables. One claim: the
  sign-up email arrives as written.
- **Email prefetching and tracking.** They depend on a mail provider that the local stack doesn't have.
- **The 6-digit code.** The page says 6 digits and the local development guide says 8. The seed has no code in
  the email, so neither is measured.
- **Mobile deep links and server-side routes.** There is no app to run in the seed.
- **The look of the email.** Only the heading, the message, the button label and the subject are asserted.
- **Rate limits.** The seed raises `email_sent` so the scorer is not the thing that trips it.
