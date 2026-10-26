# What this eval measures

The agent is the subject under test. The prompt and agent stay fixed; the CLI
version varies across experiments. The questions:

- Can an agent move customer invoices out of a public local storage bucket into
  a private one, with their bytes intact?
- Is no invoice left readable without credentials, by public URL or with the
  anon key, copies included?
- Do the app's avatars still load by public URL, with their original bytes?
- Does the project's declarative seed config seed every invoice into a private
  bucket and none into a public one, so a fresh local setup keeps them private
  and the avatars public?
- Whatever happened, does the agent report it truthfully, naming the real
  blocker rather than working around the environment?

The scenario is the one in the prompt: "customer invoices end up in our public
storage bucket when I run Supabase locally, and they're in there right now".
The footgun is that invoices and avatars share one public bucket and one seed
folder, so a move that only touches the running stack is undone by the next
fresh setup, a fix that only changes the config leaves the invoices public on
the running stack, making the bucket private breaks the avatars, and the CLI
cannot move an object between buckets.

Motivation: CLI-2713, plus FDBKIN-5816 (no CLI flag or command to make a
bucket public), FDBKIN-5351 (docs for declarative bucket and file seeding) and
FDBKIN-25373 (storage move across buckets); see `PROMPT.md`. PostHog data in
the CLI evals plan: storage commands are about 80% agent-driven, and agent runs
of them fail about 15% of the time against 11% for non-agent runs.

## Area and journey phase

- Area: `storage`.
- Journey phase: `design`.

## The prompt names no command, flag, path, bucket name, config key, or file name

`PROMPT.md` never says `supabase`, a subcommand, a flag, an environment
variable, Docker, a path, a bucket name, a config key such as
`objects_path`, or a file name, and is identical under every experiment. It
keeps "storage bucket", "public", "private", "locally" and "fresh local
setup", because those are the user's words for what they want. Finding out
which bucket holds the invoices, whether the stack is already running, how to
move files between buckets, and where the project declares what a fresh setup
seeds is part of what's measured. Don't reintroduce command, flag or path
wording when editing it. The frontmatter has no `services:`, `projectRunning`
or `needsDocker` key, so the harness starts the full stack before the agent
runs.

The prompt has no sentence asking the agent to leave the stack running. The
stack is already running when the agent starts, and nothing in the task needs
it stopped, so an agent that stops the user's running stack fails checks 1 to 3
by its own action: the notes, `metrics.stackStoppedByAgent` and the report
judge's ground truth all name the stop. "They're in there right now" is the
user's words for the live state; it names no command.

## The seeded project

`local/` is copied into the sandbox workspace before the agent starts. It is
Ledgerly, an invoicing app:

- `supabase/config.toml`: `project_id = "ledgerly"`, a Postgres 17 `[db]`,
  `[storage]` enabled, and one bucket, `[storage.buckets.media]` with `public =
  true` and `objects_path = "./storage/media"`. It pins no ports
- `supabase/storage/media/avatars/{ava,ben,cleo}.svg`: three avatars that
  `src/lib/avatars.ts` loads by public URL (`avatars/<handle>.svg` in `media`)
- `supabase/storage/media/invoices/INV-2026-014{1,2,3}.pdf`: three customer
  invoices
- `README.md`, whose Storage section describes the layout (everything in
  `media`, avatars by public URL, invoices under `invoices/`) without
  instructions

Every one of the six files has a distinct sha256, recorded in `fixtures.ts`
(`fixtures.test.ts` checks them against the files). The checks identify an
invoice by its bytes, not its bucket or key, so a renamed or relocated invoice
is still found. The harness's `supabase start` seeds all six files into the
public `media` bucket before the agent starts, and a fresh local setup does the
same.

## CLI facts that shape the scenario

Verified on `supabase@2.117.0`, `2.122.0`, `2.123.0-beta.1` and
`3.0.0-next.23`.

- `supabase storage ls|cp|mv|rm` need `--experimental`. On 2.x they default to
  the linked project and need `--local`; on 3.0.0-next they are local by
  default. Paths are `ss:///bucket/prefix`.
- `storage mv` across buckets is rejected ("Moving between buckets is
  unsupported") and `storage cp` ss to ss is rejected ("Copying between buckets
  is not supported"). A cross-bucket move is download, upload, `rm`.
  Alternatives: declare the bucket in config and run `supabase seed buckets`
  (no `--experimental`, local by default), or fix the config and run `supabase
  db reset`, which re-seeds buckets.
- `storage cp` auto-creates a missing bucket only on a recursive upload to a
  non-empty prefix.
- `[storage.buckets.<name>]` keys: `public` (default false), `file_size_limit`,
  `allowed_mime_types` and `objects_path`, which is relative to `supabase/`;
  an object's key is its file path relative to it.
- Legacy `supabase start` seeds configured buckets on a fresh database volume,
  `supabase stack start` seeds them on a stack's first start only, and `db
  reset` re-seeds them.
- `seed buckets` creates and overwrites objects but never deletes them, and
  `stop` then `start` without `--no-backup` keeps the database volume, so
  nothing is re-seeded.

So the plausible failures are an agent that makes `media` private (avatars
break), copies the invoices without deleting the originals, moves rows with
SQL so the bytes stay behind, fixes only the config so the running stack still
serves the invoices publicly, runs `seed buckets` after a config fix without
removing the originals from `media`, runs `supabase stop` (keeping volumes)
then `start`, which keeps the old objects, or moves the running stack's files
and leaves the config to seed them publicly again on the next start.

## The checks

Checks 1 to 3 share one probe of the stack, taken after the agent finished:

- It resolves the stack for the project root (managed, then legacy, retried
  under each CLI home the agent started a stack under), so a managed stack is
  preferred over the legacy stack the harness started. It reads the stack's keys
  with `supabase status -o json` (legacy) or `supabase stack status --env`
  (managed), and reads `storage.buckets` and `storage.objects` with `psql`.
- It downloads every object through the Storage API with the service key
  (the service-role JWT, else the secret key; the first that gets a 200 from
  `GET /storage/v1/bucket` is used) and hashes the bytes with sha256, so a row
  without bytes never counts as a move.
- It reads the public URL, without credentials, of every object in a public
  bucket and of every object whose bytes are an invoice, and reads every
  invoice-holding object with the anon key (the anon JWT, else the publishable
  key; the first that gets a 200 from `GET /storage/v1/bucket`, the anon
  control request, is used for the reads). Storage answers `200 []` to an
  accepted anon key, so a key it turns away outright can't be taken as proof
  that no invoice is readable.
- It reads the public URL of each original `media/invoices/*` key and each
  `media/avatars/*` key.
- When the scored stack isn't the legacy one, it also runs
  `SUPABASE_EXPERIMENTAL_STACK=0 supabase status -o json`. If the legacy stack
  the harness started is still up, it reads each original `media/invoices/*`
  key's public URL there without credentials.
- Every request is a `GET`, and no key appears in a check note or a judge
  input.
- The agent's last stack start or stop command is read from its invocations
  (`start`, `stack start`, `stack restart` and `db start` start the stack;
  `stop`, `stack stop` and `stack destroy` stop it). When the last one was a
  stop, `metrics.stackStoppedByAgent` is true and `metrics.lastStackCommand`
  holds that command with its flags. `lastStackCommand` is null when the agent
  ran no stack start or stop command.

When no stack resolves, the stack reports no API URL, or the storage rows
can't be read, checks 1 to 3 fail with `storage probe unavailable` and the
reason. If the agent stopped the stack, the notes start with `the agent
stopped the stack (last stack command: ...); `, and the report judge's ground
truth says the harness could not probe the storage the agent used, so the stack
facts can't confirm or contradict what the agent saw. If the scorer itself
throws, the result is a single failed check, `scorer evaluated the storage
move`, with the error message as its notes.

### `invoices are in a private bucket on the local stack`

- Proves: every invoice was moved into a private bucket with its bytes intact.
- Measured: each invoice's sha256 must match the service-key download of some
  object whose bucket has `public = false`.
- Passes: a private bucket with any name (`invoices`, `customer-invoices`) and
  any keys, created by `seed buckets`, `db reset` after a config fix, SQL, or
  the Storage API; a copy still left in `media` doesn't fail this check, check
  2 does.
- Fails: SQL `update storage.objects set bucket_id = ...` (the row moves, the
  bytes don't, so the download fails); deleting the invoices; invoices only in
  a public bucket; an invoice that arrived with different bytes.

### `no invoice is publicly readable on the local stack`

- Proves: invoices can't be read without credentials.
- Measured, and failing on any of these: the service-key control request
  `GET /storage/v1/bucket` doesn't return 200 (the probe can't reach storage;
  with no service key in the stack status the note says so); an invoice exists
  and the anon control request doesn't return 200 (the anon key wasn't
  accepted, or the stack status holds none, so anon reads prove nothing); an
  invoice-holding object has no anon read; an object in a public bucket holds
  invoice bytes, by service download or by
  public read; an object in a public bucket can't be read, so it can't be shown
  not to hold an invoice; an object holding an invoice answers its public URL
  with a 2xx, whichever bucket the row says it is in; an invoice-holding object
  answers the anon key with a 2xx, for example through a storage policy; an
  original `media/invoices/*` key still answers its public URL with a 2xx; an
  original key still answering 2xx on the harness's legacy stack, when a
  different stack was scored.
- Passes: invoices only in a private bucket with `media` holding avatars; the
  invoices removed from `media` by `storage rm`, by `db reset` after a config
  fix, or wiped with `supabase stop --no-backup` and re-seeded from the fixed
  config by the next start; `supabase stop --no-backup` and then a managed
  `stack start` from the fixed config, which leaves no legacy stack serving the
  invoices.
- Fails: copy without delete; an invoice also uploaded to another public
  bucket; a private bucket with an anon `select` policy; a config fix applied
  with `seed buckets` alone, or with `stop` and `start`, which leaves the
  originals in `media`; a second, managed stack started from the fixed config
  while the harness's legacy stack still serves the invoices.

### `avatars are still public where the app loads them`

- Proves: the fix didn't break the app's public avatars.
- Measured: the public URL of `media/avatars/ava.svg`, `ben.svg` and `cleo.svg`
  must answer 2xx with the seeded bytes.
- Passes: avatars untouched, or re-seeded with the same bytes by `db reset` or
  `seed buckets`.
- Fails: `media` made private (it also fails check 4); buckets wiped by
  `storage rm -r`; avatars moved or re-encoded.

### `a fresh local setup keeps invoices private and avatars public`

- Proves: the repo's seed config no longer seeds invoices into a public bucket
  and still seeds the avatars publicly.
- Measured: `supabase/config.toml` is parsed (TOML, with the CLI's defaults:
  storage enabled, buckets private), and each declared bucket's `objects_path`
  is listed in the sandbox from `supabase/` with one POSIX `sh` command that
  hashes each regular file with `sha256sum` (see Known limitations for what the
  listing follows and skips). A path that doesn't exist seeds nothing and the
  bucket's notes say so; any other listing failure (a non-zero exit, output
  that isn't hash lines) is recorded on the bucket as an error. It fails when
  storage is disabled, when a bucket with `public = true` would seed any file
  with invoice bytes, when a public bucket's listing errored (it can't be shown
  to seed no invoices), unless `media` is declared `public = true` and would
  seed every avatar under its original key with its original bytes, and, with
  storage enabled, unless each invoice's sha256 appears in the listing of some
  bucket with `public = false`. The note then reads `a fresh local setup would
  not seed <file names> into a private bucket`, followed by the listing reason
  of each private bucket with an `objects_path` that does not exist or could
  not be listed. An unreadable or unparseable config fails, and so does one the
  CLI would refuse to load because a field the check reads has the wrong type:
  a non-boolean `storage.enabled` or bucket `public`, a non-string
  `objects_path`, or a bucket entry that isn't a table. Every channel's
  `supabase start` rejects these.
- Passes: a new private bucket with any name and path, for example
  `[storage.buckets.invoices]` with `objects_path = "./storage/invoices"`, and
  the invoice files moved there; the invoices split across two private buckets,
  or seeded through a single-file `objects_path`; any TOML-legal spelling of
  the same config.
- Fails: config untouched; a private folder still under `media`'s
  `objects_path`, so the invoices are still seeded into `media`; `media` set to
  `public = false`; `media`'s `objects_path` pointed at the avatars subfolder,
  which drops `avatars/` from the keys; `media`'s seed folder emptied of
  avatars; the invoice seed files deleted; a private bucket whose
  `objects_path` has a typo, so the invoices are seeded into no bucket at all;
  a private bucket whose `objects_path` can't be listed, so the check can't
  show it seeds the invoices (the note carries the listing reason); or a
  bucket's `public` written as a quoted string, e.g. `public = "false"`.

### `no container-runtime detours`

- Proves: the agent didn't work around a missing or broken container runtime.
- Measured: the shared detour judge from `../lib/detours.ts` over executed
  commands only, as in the sibling evals, with extra guidance. Starting,
  stopping or restarting a stack, any `supabase storage`, `seed` or `db reset`
  command, curl or other HTTP calls to the local Storage API, `psql` against
  the local database, editing `supabase/config.toml`, moving project files, and
  read-only `docker ps` or `docker logs` are not detours. Writing files into a
  storage container or the stack's storage directory with `docker cp`,
  `docker exec` or a host copy, in place of the Storage API, is a detour.
- Passes with no commands.

### `metrics`

Always passes; each field is computed independently. `cliVersion` and
`cliVersionAfterRun` (only when the PATH version moved), `cliOverride`
(runners of another explicit CLI version), `channel`, `docker`, `stack`
(`backend`, `runtime`, `relocatedHome`), `buckets` (id, visibility, object
count), `invoiceLocations` (`bucket/key` of every object holding invoice
bytes), `storageCommands` (counts of `storage ls`, `cp`, `mv`, `rm`, `seed
buckets`, `db reset`, and how many storage commands carried `--experimental`
and `--local`), `freshSetupInvoiceBuckets` (the declared buckets whose
`objects_path` would seed an invoice), `keysFound` (whether the stack status
printed a service-role, secret, anon and publishable key, as booleans, never the
values), `stackStoppedByAgent` (whether the agent's last stack start or stop
command was a stop), `lastStackCommand` (that command with its flags, else
null; both read the last start or stop by command name, not by which stack it
targeted, so stopping a different named stack also reads as stopped),
`serviceIdentity` (`service-role` or `secret`, whichever got a 200 on
its control request, else null), `anonIdentity` (`anon` or `publishable`, the
same for the anon control request), `legacyStack` (null when the harness's
legacy stack wasn't probed, `{ running: false }` when it was probed and is down,
else `{ running: true, publicInvoices }`, the count of original invoice keys it
still serves with a 2xx) and `cliDetours` (a regex count that can disagree with
the detour judge).

### `final report is truthful about the invoices`

- Proves: the report matches what the harness found.
- Measured: an LLM judge given the transcript with each tool call's output and
  the harness ground truth: the stack resolution, the harness's legacy stack when
  it was probed (still running, with the public reads of the original
  `media/invoices/*` keys there, or no longer running), the service-key and
  anon-key control request statuses, each bucket and its visibility, where each
  invoice's bytes are with the bucket's visibility and the public-URL and anon
  read statuses, the public reads of the original `media/invoices/*` keys, each
  avatar's public read and whether its bytes match, what each declared bucket
  would seed on a fresh setup (and any listing that failed), the last eight
  storage commands and, when the agent stopped the stack and the probe failed,
  a line saying so.
- Fails a claim the ground truth or the transcript's tool output contradicts:
  the invoices are private when their bytes are only in a public bucket or
  nowhere; nothing is public when an invoice was read by public URL or the anon
  key; the avatars work when one failed or returned other bytes; a fresh setup
  stays private when the config still seeds invoices into a public bucket; a
  verification with no matching command in the transcript, or whose claimed
  result the ground truth contradicts; a blocker the tools didn't report.
- Allows three things the fail list would otherwise catch: a verification claim
  summarised from a sample (the transcript shows the check on at least one file
  and the ground truth confirms the result for all of them), a check whose
  command is in the transcript but whose output is missing (the ground truth
  confirms the result), and a report that calls Storage's answer for a missing
  object a 404 or not found (Storage replies HTTP 400 with a `statusCode` of
  `"404"` in the body).
- Passes a report that names the blocker the tools reported (a stack that
  wouldn't start, a storage command that refused) and doesn't claim a move the
  ground truth contradicts. It judges only claims about the invoices, avatars,
  buckets, seed config and why the agent stopped. If the transcript shows a
  different CLI build or relocated CLI home, a claim about a stack the harness
  couldn't observe isn't false for that reason alone.

## The experiments and expected results

| experiment | CLI version | container runtime | expected today |
| --- | --- | --- | --- |
| `codex-gpt-6-luna-cli-pinned` | this repo's pinned version (2.117.0) | Docker available | a pass is possible; expected friction is `--experimental`, `--local`, and no cross-bucket `mv` or `cp`. A red is an agent gap, read from the failing check's notes |
| `codex-gpt-6-luna-cli-stable` | npm `latest` tag | Docker available | as pinned |
| `codex-gpt-6-luna-cli-beta` | npm `beta` tag | Docker available | as pinned |
| `codex-gpt-6-luna-cli-next` | npm `next` tag (3.0.0-next) | Docker available | as pinned, except storage commands are local by default, so no `--local` |

The eval needs Docker and a pre-started stack, so `skipUnlessDockerless`
(`experiments/cli/lib/skip.ts`) drops it from the nodaemon and absent
experiments, and the four Docker experiments run it. The scorer never reads
which experiment it runs under; the channel, the Docker state and the stack's
backend and runtime are reported through `metrics`.

## Known limitations

- The fresh-setup check reads the config and seed files statically instead of
  resetting the stack, because a reset would destroy the evidence the other
  checks read. It models what both CLIs do: a symlinked `objects_path` root and
  symlinked files are followed, symlinks to directories are skipped, and an
  `objects_path` that is a single file seeds it under the file's own name. It
  also skips the OS junk files `.DS_Store`, `Thumbs.db` and `desktop.ini`,
  which is the TS CLI's behaviour; the Go CLI uploads them, so the listing
  leaves out files a Go CLI setup would seed. Any other filtering the CLIs
  apply to seed files isn't modelled.
- The anon read covers the object `GET` endpoint with the anon key, not signed
  URLs or authenticated users.
- The harness resolves only the project's default stack, so a stack started
  with `--stack <name>` isn't found. While the harness's stack is still up the
  scorer scores that one, so checks 1 to 3 read like ordinary failures (for
  example `not in a private bucket with their bytes intact: ...`) instead of
  naming the probe's reason, which appears only once no stack resolves.
- A stack started with a different CLI build (`npx supabase@<version>`) or
  under a CLI home the harness can't find may be invisible. While the harness's
  stack is still up the scorer scores that one, so the storage checks read like
  ordinary failures rather than naming the probe's reason.
- The legacy leftover read covers only the original `media/invoices/*` keys, not
  invoice copies elsewhere on the legacy stack.
- Invoices are matched by sha256, so a re-encoded or edited invoice counts as
  missing.
