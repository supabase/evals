# build-docs-034-vault

## What this eval measures

The subject is [Vault](https://supabase.com/docs/guides/database/vault), not the agent. The prompt is a product request
plus the page's url, and the checks say whether an agent that read the page keeps a key a database function needs.

One claim: a database function signs links with a key that is stored encrypted, is in no repo file, is unreadable by app
users, and is read at call time so a changed key takes effect at once.

## Do not reintroduce the vocabulary

Keep all of these out of `PROMPT.md`:

vault, secret, encrypt, decrypt, decrypted_secrets, create_secret, update_secret, pgsodium, security definer, grant,
revoke, privilege, role, anon, authenticated, setting, config.toml, `[db.vault]`, env().

## The seed carries the contract

- `local/DOWNLOAD_LINKS.md` fixes the function name, its argument, the link format and the signature. The link check
  needs a fixed shape to verify, so the contract is given rather than discovered.
- `local/.env` holds the key, and `local/.gitignore` ignores it. The key is a random value, so no memorized answer
  produces a valid signature.
- `public.reports` lets an agent look a report up before signing. The scorer adds a report row for each path it asks for,
  so an agent that checks the path exists is not refused.
- `config.toml` has no `[db.vault]` section. An agent can add one that reads the key from `.env`, or create the entry
  with SQL that stays out of the repo. Both pass.

## Do not drop the positive controls

`app users cannot read the signing key` passes for a project with no key at all. `a signed-in user gets a link the CDN
accepts` makes it mean something, because a valid signature needs the key. `the signing key is not in plain text
in the database` and `the signing key is not in a file the repo would commit` pass for a project that never stored the
key, and `the signing key is stored in the vault` pairs with them.

## How the checks read the end state

- `the signing key is not in a file the repo would commit` runs `git init` in the workspace, lists every file git would
  commit outside `node_modules`, and searches them for the key.
- `the signing key is not in plain text in the database` reads every table outside `vault` and `supabase_migrations`,
  plus function bodies and settings, trigger arguments, view definitions, policies, check constraints, column defaults,
  comments, and database and role settings. `supabase_migrations` is left to the repo check, so a key in a migration
  costs one check.
- Both are literal matches on the key. An encoded or split key passes them. A function that hardcodes one still fails
  the rotation check.
- `app users cannot read the signing key` runs as `anon` and as `authenticated`. It reads every table and view the role
  can select. It calls every function in `public` the role can execute that takes no arguments, or one text or uuid
  argument, which it passes each name and id of the vault entries holding the key. A read the database refuses is not a
  leak. A view over the decrypted view is refused to both roles, so it does not count.
- The link is requested as `authenticated` through SQL with the role set, not through the API.
- A `[db.vault]` section lands only when the stack is reset or restarted. An agent that adds one and never applies it
  fails `the signing key is stored in the vault`, and the note says so.

## Order of the scorer

The repo check runs first, before anything writes. The scorer then applies pending migrations with `supabase migration
up --local`, which writes to the database, so score once per stack. `links follow a change of the signing key` rotates
every vault entry that holds the key, so it runs last.

## The guide has to actually be read

`the agent read the Vault guide the prompt referenced` requires a docs call that reached the page with content. Read
`docs.calls` before reading a score.

## Checks expected to saturate

The migration check, `the signing key is stored in the vault`, and `app users cannot read the signing key`. The signal
is expected in the repo check, the link check, and the rotation check.

## What this eval does not score

- **The API path.** The function is called with the role set in SQL, so whether PostgREST exposes it is not scored.
- **Who besides signed-in users can get a link.** The prompt does not say.
- **Whether a teammate gets the key from a fresh clone.** An agent that created the entry with SQL passes.
- **Hosted projects.** The root key, key portability and the dashboard are out of reach locally.
