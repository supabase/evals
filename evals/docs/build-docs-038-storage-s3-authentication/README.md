# build-docs-038-storage-s3-authentication

## What this eval measures

The subject is [S3 Authentication](https://supabase.com/docs/guides/storage/s3/authentication), not the agent. The
prompt is a product request plus the page's url, and the checks say whether an agent that read the page gives each S3
client the access it should have.

One claim: an S3 client made for a signed-in person reaches only that person's notes, and the server job's client
reaches everyone's.

The starting claim was that the S3 endpoint accepts valid keys and refuses others. That held on the local stack, and it
is narrowed here to which credential goes where.

## Does an existing eval cover it?

No. `build-docs-008-storage-access-control` scores policies and bucket visibility through the Storage REST API from a
browser. `build-docs-023-storage-bucket-fundamentals` scores bucket visibility and limits. Neither uses the S3 protocol
or chooses between credentials. Here the bucket is given, and the policies are part of the task because a per-person
S3 client goes through them.

`a signed-in user can sync a note again` overlaps the access control page, and 008 leaves replacing a file out of
scope. It belongs here because over S3 every upload is an upsert. Even a first upload needs the read rule as well as the
insert rule, and an overwrite also needs the update rule, which a REST upload without upsert does not.

## Do not reintroduce the vocabulary

Keep all of these out of `PROMPT.md`:

access key, secret access key, session token, token, JWT, anon, publishable, service role, secret key, credentials,
RLS, row level security, policy, `storage.objects`, bypass, region, endpoint, `forcePathStyle`, stub, project ref,
`supabase status`.

"S3" stays, because `package.json` and `STORAGE.md` already name the SDK. `STORAGE.md` names the factory's argument
`accessToken`, as the app's own code would.

## The seed carries the contract

- `local/STORAGE.md` fixes the bucket, the folder per user id, the two factory names and their arguments, which folder
  ships, and which env file each side reads. The probes need named entry points.
- The init migration makes the `notes` bucket, private, with no policies on it.
- `local/desktop/.env` holds the api url and the publishable key, as the app already has. On the pinned Storage the
  S3 endpoint does not accept the publishable key, so a client built from what the file holds fails to sign.
- `local/backup/.env` holds the api url only.
- `local/package.json` and `local/package-lock.json` pin `@aws-sdk/client-s3`, `@supabase/supabase-js` and everything
  under them.

## The scorer installs packages

The scorer runs `npm ci` in the sandbox, so it needs network access to the npm registry. When the install fails, every
probe check reports not run and the eval fails. A failed `project dependencies installed` is a lost run, not evidence
about the page. An agent that adds a package has to leave the lockfile in step with `package.json`.

## How the checks read the end state

- The scorer copies `desktop/` on its own into a fresh temporary directory outside the workspace, links the
  workspace's `node_modules` beside it, and loads `storage.js` from there with only that folder's `.env` and an
  otherwise empty environment. A desktop client that reads a relative path into `backup/` fails to load, as it would in
  the installer. An absolute path into the workspace is not caught.
- `backup/storage.js` loads in place with `backup/.env`.
- Each run signs up two users and adds one note for each, with names scoped to the run. The scorer sets `owner` and
  `owner_id` on each note to its user, so policies keyed on the folder and policies keyed on the owner both pass.
- A read refusal counts only as `NoSuchKey` or `AccessDenied`, and a write refusal only as `AccessDenied`. A signature
  error means the client never signed in, and the check reads it as not measured.
- `a signed-in user cannot change another user's notes` overwrites their note and adds one to their folder. The second
  fails the check under owner-keyed policies too, because it takes a key that person's sync would write.
- `no file in the desktop app holds a full-access key from the project` is a literal match. It scans `desktop/` for
  the S3 secret, service role key, secret key and JWT secret that `supabase status` reports, so an encoded or fetched
  copy slips past it. The refusal checks catch a desktop client that gets such a key another way and uses it.
- The scorer applies pending migrations, so score once per stack.

## Do not drop the positive controls

The two refusal checks and the key scan pass for a desktop app that reaches nothing. `a signed-in user can list and read
their own notes`, `a signed-in user can upload a new note` and `a signed-in user can sync a note again` make them mean
something. `the backup job reads every user's notes` is the positive control for the server side.

## The guide has to actually be read

`the agent read the S3 authentication guide the prompt referenced` requires a docs call that reached the page with
content. Read `docs.calls` before reading a score.

## Checks expected to saturate

The migration, install and key scan checks, and both refusal checks for an agent that gives the desktop the per-person
client. The signal is expected in `a signed-in user can sync a note again`, which fails a solution with read and insert
rules only. The own-notes control fails an agent that uses the publishable key from `desktop/.env`.

## What this eval does not score

- **What Storage accepts.** Refusing the publishable key and signing a person in only with `stub` and the legacy anon
  key are what the storage-api of CLI 2.117.0 (v1.72.1) does. When Storage accepts the new keys, an agent that uses the
  publishable key turns green with no docs change. Read a change in verdict after a CLI upgrade that way first.
- **Deleting notes.** `STORAGE.md` does not ask for it.
- **Token expiry.** The factory takes a token on every call.
- **Whether `backup/.env` stays out of git.** The prompt does not say.
- **Hosted and self-hosted values.** The project ref, the direct storage hostname and the self-hosted tenant id are out
  of reach locally.
