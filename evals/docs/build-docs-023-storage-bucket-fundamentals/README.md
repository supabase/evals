# build-docs-023-storage-bucket-fundamentals

## What this eval measures

The [Storage Buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals) guide, not the agent. The
prompt is a product request plus the page's url, and the checks say whether an agent that read the page set up
buckets with the right visibility and limits. A gap in the page counts as a failure.

One claim: **a bucket has the right visibility and limits.** The page says private is the default, that a public
bucket serves files to anyone with the url, and that max file size and allowed content types "are also defined at
the bucket level". It never says how to set the limits. It links to
[Creating Buckets](https://supabase.com/docs/guides/storage/buckets/creating-buckets#restricting-uploads), which
shows them only through the JavaScript client (`fileSizeLimit: '1MB'`, `allowedMimeTypes: ['image/*']`). A project
in a repo keeps its buckets in a migration or in `config.toml`, where the same settings are bytes and strings
(`file_size_limit` is a bigint in SQL and `"2MiB"` in TOML), so the unit is the thing the page leaves to the agent.

Checked against the page at supabase/supabase `10d3ad0bc6`.

## Does an existing eval cover it?

No. `build-docs-008-storage-access-control` is the Access Control guide: it scores policies on `storage.objects`
and that a private bucket serves one owner only. `evals/benchmark/build-storage-001-private-bucket-access` is
policies and signed urls. Nothing in `evals/` sets or probes a bucket's size or type limits, and the public side
of the visibility claim has no eval at all.

## Where the checks came from

No user evidence for this page turned up, which the ticket said to expect. The inventory is thin and says so.

- **Reached:** the page itself against its sibling Creating Buckets guide, and `build-docs-008`'s README, which
  records that the sibling passes `public: true` in both examples. The `[storage.buckets.<name>]` keys in
  `config.toml` are from memory of the CLI, not read from a reference, so the lifecycle check treats them as a
  risk (see the end).
- **Out of reach:** Linear, Slack, Hex, the internal report. `supabase/agent-skills` has no user feedback on
  bucket limits.

**A finding for the docs team.** The page's own example use case for a public bucket is "User profile pictures".
`build-docs-008` treats profile pictures as the case where a private bucket is right. Both can be correct, but a
reader who follows this page for photos of people ends up with the bucket 008 fails. This eval's seed uses press
photos and invoices so it doesn't depend on which way that goes.

## Do not reintroduce the vocabulary

Keep all of these out of `PROMPT.md`:

bucket, public, private, visibility, file size limit, max file size, allowed mime types, content type, mime,
restrict, `fileSizeLimit`, `allowedMimeTypes`, `storage.buckets`, `createBucket`, policy, RLS, signed url, access.

"Anyone with the link", "turned away" and "nothing over 2 MB" are how the user says it.

## The seed carries the contract

- `local/app/files.ts` fixes the two names, `press-photos` and `invoices`, as constants the backend already uses.
  The scorer needs the names to read and probe, and an unnamed pair would red every agent that chose a different
  spelling. It buys an observable answer at the cost of the discovery question. The prompt points to the file.
- The requirements are in the prompt, in the user's words: images only and under 2 MB for the photos anyone can
  see, PDFs up to 10 MB for invoices that a link must not open, and "anything that isn't the right kind of file or
  is too big should be turned away". The last clause is there so that a size check written into `files.ts` doesn't
  stand in for the project's own setting.
- The backend is described as using the secret key, so nobody signs in and no policy is needed. Policies are
  `build-docs-008`'s subject and can't fail this eval for the wrong reason.
- No bucket is declared in `config.toml` and no migration exists. A fresh stack has no buckets.
- `services: kong, postgrest, storage-api`. Auth isn't needed. `kong` doesn't come up without `postgrest`.

## How the scorer works, and why in this order

1. **The lifecycle first** (`the agent applied the migrations it wrote`, `the buckets declared in config.toml
   exist`). A bucket written into a migration or declared in `config.toml` but never applied would red every probe
   for a step this page says nothing about, so the scorer applies what is pending (`migration up --local`,
   `supabase seed buckets --local`) and each costs one check.
2. **Within-limits uploads before refusals, per bucket.** A refusal only means something in a bucket that takes
   the right file, so the accepted upload is the positive control. When it fails, the refusal checks fail with a
   `not run` note instead of passing for a bucket that doesn't exist.
3. **Visibility last**, because it reads the stored object.

Refusals are read from `storage.objects` as the superuser, not from the API's message, so a request the probe
itself malformed can't pass as a refusal. Every path and body carries a per-run marker.

Probes use the server key. Bucket limits and visibility apply to it, and it bypasses policies, so what is
measured is the bucket's own settings. The visibility probes are plain GETs of the public url.

## Do not drop the positive controls

- Both `turned away` checks pass for a bucket that doesn't exist, if they ran. They don't run: the accepted
  upload gates them.
- `a link alone does not open one` first reads the invoice back with the server key, so an object that was never
  stored can't read as "not served".
- The accepted samples sit well inside each limit and the refused ones well outside, so 2 MB as 2,000,000 or
  2,097,152 bytes gives the same verdicts. A limit set in the wrong unit (2048 for 2 MB) refuses the 1.5 MB photo
  and fails the accepted check.
- The photos bucket is probed with both a png and a jpeg and refused a PDF, so `image/png` alone fails and a
  list that also allows PDFs fails. The invoices bucket is refused a png.

## Predicted to saturate, and what failed

The probes were run against a fake Storage that enforces size, type and visibility as I understand the API, not
against a real stack. Predictions were written before running and all held.

| Configuration | Red checks |
| --- | --- |
| photos public, 2 MB, `image/*`; invoices private, 10 MB, PDF (decimal or binary MB) | none |
| photos left at the default | `anyone with the link can see a photo` |
| invoices made public | `a link alone does not open one` |
| no limits at all | all four refusal checks |
| photos limit in bytes confused for MB (2048) | photos accepted, both refusals, visible |
| photos types `image/png` only | photos accepted, both refusals, visible |
| photos also allow `application/pdf` | `a PDF is turned away` |
| photos limit raised to 50 MB | `a 3 MB image is turned away` |
| invoices limit copied as 2 MB | all four invoices checks |
| nothing created | all eight |

Visibility is the likely saturated half: the page states it, and `invoices` is private by default so it passes
once the bucket exists. The signal is in the limits, which the page only names.

## The guide has to actually be read

`the agent read the storage buckets guide the prompt referenced` fails unless a docs call returned the page's
content. Read `docs.calls` before the score. An agent that follows the page's link to Creating Buckets reads a
different page; that counts, because the gap is in this one.

## What this eval does not score

- **Policies, and who may upload.** `build-docs-008`'s claim. The probes bypass them.
- **The global `[storage] file_size_limit`.** The seed keeps the CLI's 50 MiB, above both buckets. A bucket limit
  can't exceed it, which only matters for a request this prompt doesn't make.
- **Whether a list of types is exactly right.** `image/*` and an explicit list both pass if png and jpeg are in it.
  Webp, gif and the like are not probed.
- **The exact boundary.** 2 MB is probed at 1.5 MB and 3 MB, 10 MB at 8 MB and 12 MB, because the unit (decimal or
  binary) isn't the page's claim.
- **Public bucket caching and performance.** The page mentions it; the prompt asks for nothing about speed.
- **Resumable and S3 uploads, and image transformations.** Other pages.
- **Which route created the bucket.** A migration, `config.toml`, a client call or the dashboard all land in
  `storage.buckets`. Whether it survives a reset is `build-docs-020`'s kind of claim.
- **Extra buckets.** An unrelated public bucket doesn't fail anything here, because the claim is about the two
  named ones.

## Risks worth knowing before the first run

None of these have met a real stack.

- **Server key and limits.** The probes assume Storage applies a bucket's size and type limits to the server key
  as it does to any role. If it doesn't, both refusal checks pass vacuously on a correct bucket and fail on none.
  The accepted control still gates them, but a baseline where the refusal checks never red should be tested by
  uploading as a signed-in user before it is believed.
- **The content type comes from the upload.** The probes set it explicitly. The type check measures what Storage
  does with the declared type, which is also what a browser sends.
- **A private bucket's public url answers 400 or 404, not 200.** The check only requires that it isn't a 200
  with the object's bytes.
- **`supabase seed buckets --local`** is assumed present in the pinned CLI (2.117.0). If it isn't, a bucket
  declared in `config.toml` costs the declared-buckets check and, because the scorer couldn't create it, every
  probe on that bucket. The note says the seed failed.
- **First of its kind:** large uploads (12 MB) through Kong from the scorer. The agent's timeout doesn't bound the
  scorer; the cost is wall-clock.
