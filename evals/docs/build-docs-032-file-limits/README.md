# build-docs-032-file-limits

## What this eval measures

The [File Limits](https://supabase.com/docs/guides/storage/uploads/file-limits) guide, not the agent. The prompt is a
product request plus the page's url, and the checks say whether an agent that read the page left a project that
refuses a file over the size it was asked to cap.

One claim: **an upload over the size limit is refused.** The page says the global file size limit is set in the
Dashboard's Storage Settings (50 MB on Free, 500 GB on Pro and Team), that a bucket can have a smaller limit of its
own, and that a bucket's limit "must be lower than the global limit". It names no local setting at all. A project in
a repo keeps it in `config.toml` as `[storage] file_size_limit`, and a bucket's own in `[storage.buckets.<name>]`.

## Confirming the claim

The ticket's claim is a reading of the page, so I tried it on a real local stack (CLI 2.117.0, storage-api v1.72.1,
`kong`, `postgrest`, `gotrue` and `storage-api` only). Two buckets declared in `config.toml`, `tickets` with no limit
of its own and `reports` at 25 MiB, uploads of 3 MB and 8 MB as the server key.

- **Confirmed:** a bucket's own limit refuses an over-size upload (`413 EntityTooLarge`), and nothing is stored.
- **Confirmed, and not what the page says:** on a local stack the global limit does not cap anything by itself.
  - Setting `[storage] file_size_limit = "5MiB"` and running `supabase stop` then `supabase start` left an existing
    `tickets` bucket at 50 MiB, and an 8 MB upload went in. The container was started with `FILE_SIZE_LIMIT=5242880`.
    The limit only reached the bucket after `supabase seed buckets --local`, which copies the global value into the
    bucket row.
  - `reports`, declared with 25 MiB, kept accepting 8 MB with the global limit at 5 MiB. The page's "must be lower than
    the global limit" is not enforced locally.
  - A bucket created later with no limit of its own accepted 8 MB, 12 MB and 60 MB, past the 50 MiB default.
- **Not confirmed:** hosted behavior. The Dashboard setting and the plan caps can't be measured on a local stack.

So an agent that follows the page to the letter, "set the global limit", leaves `reports` open locally, and one that
edits `config.toml` and only restarts leaves `tickets` open. Both are findings for the docs ticket: the page says
nothing about the local file, the seeding step, or that a bucket's own higher limit survives a lower global one.

## Does an existing eval cover it?

No. `build-docs-023-storage-bucket-fundamentals` sets a bucket's size and type limits, but through the Storage
Buckets guide, with one limit per bucket and no project-wide cap. Nothing in `evals/` exercises the File Limits
guide, the global limit, or a bucket seeded with a limit above the one asked for.

## Where the checks came from

No user evidence for this page turned up, which the ticket said to expect.

- **Reached:** the page, its sibling Creating Buckets guide (`#restricting-uploads`), and the real stack above.
- **Out of reach:** Linear, Slack, Hex, the internal report. `supabase/agent-skills` has nothing on upload limits.

The two refusal checks come from the stack, not the page: the page implies a single cap that covers every bucket, and
the stack shows it does not. That is the diff against the page.

## Do not reintroduce the vocabulary

Keep all of these out of `PROMPT.md`:

limit, file size limit, max file size, global, bucket, storage settings, Dashboard, `file_size_limit`, `config.toml`,
`seed buckets`, allowed mime types, 413, payload, policy.

"Nothing over 5 MB should be accepted", "either place" and "whoever or whatever is sending it" are how the user says
it. The last clause keeps a size check written into `app/uploads.ts` from standing in for the project's own setting.

## The seed carries the contract

- `local/app/uploads.ts` names the two places, `tickets` and `reports`, as constants the backend already uses. The
  scorer needs the names to probe, so they are given. That buys an observable answer at the cost of the discovery
  question of what to create.
- `config.toml` declares both buckets, `tickets` with no limit of its own and `reports` at 25 MiB, with the project's
  global limit at the CLI default of 50 MiB. The `reports` limit is the conflict: it is above what the user asks for,
  so lowering only the global limit cannot satisfy both places. The comment says the old exporter made long PDFs and
  names no setting.
- The backend uses the secret key, so nobody signs in and no policy is needed. Policies are `build-docs-008`'s subject
  and can't fail this eval for the wrong reason.
- `services: gotrue, kong, postgrest, storage-api`. Storage doesn't need `gotrue`, but with it excluded `supabase
  status` on this CLI reported no keys, and the scorer can't call Storage without one.

## How the scorer works, and why in this order

1. **Restart the stack** (`supabase stop` then `start`). Storage reads its settings when its container is created, so
   a `config.toml` edit counts even if the agent never restarted. An invalid value fails here and costs
   `the local stack starts with the project settings`, and the rest report `not run`.
2. **Seed the buckets, then compare.** A limit declared in `config.toml` only reaches a bucket that already exists
   after `supabase seed buckets --local`, and the page says nothing about it. The scorer reads every bucket's limit,
   seeds, and reads again. A row that changed means the agent had written settings it never applied, which costs
   `the agent applied the bucket settings it wrote` and nothing else, because the uploads then measure the seeded
   state. The cost: seeding rewrites every declared bucket from `config.toml`, so a limit set through the Storage API
   or SQL for a bucket that `config.toml` declares differently is overwritten and read as unapplied.
3. **Under-limit uploads before refusals.** A 3 MB file goes into each place first. That is the positive control.
4. **Over-limit uploads, one per place.** An 8 MB file goes into each place that took the 3 MB file.

Uploads use the server key, which bypasses policies, so what is measured is the project's size limits. Refusals are
read from `storage.objects` as the superuser, not from the response, and every path carries a per-run marker. A
bucket's own limit is read from `storage.buckets` and quoted in the notes, so a red says which limit let the file in.

3 MB and 8 MB sit well either side of 5 MB, so 5 MB read as 5,000,000 or 5,242,880 bytes gives the same verdicts.

## Do not drop the positive controls

An agent that built nothing refuses nothing, and a project that refuses every upload refuses everything.
`files under 5 MB are accepted in both places` is what separates a limit from a wall. When it fails, both refusal
checks fail with a `not run` note instead of passing for a bucket that takes no file. Drop it and a project capped at
1 MB scores full marks on the other two.

## What each check proves

| Check | Proves |
| --- | --- |
| `the local stack starts with the project settings` | The settings are valid and the stack comes up on them. |
| `the agent applied the bucket settings it wrote` | What `config.toml` declares is what the buckets have. |
| `files under 5 MB are accepted in both places` | The cap is not below 3 MB, and uploads still work. |
| `a file over 5 MB is refused in tickets` | The place that had no limit of its own now refuses. |
| `a file over 5 MB is refused in reports` | The place seeded with a higher limit now refuses. |
| `the agent read the file limits guide the prompt referenced` | The page was opened with content. |

## Predictions, and what the probes were run against

The probes ran against a real local stack (the one described above), with the two buckets' limits set directly for
each state. Predictions were written first and all held. Total time for the seven rounds was about 12 seconds.

| State of the two buckets | Red |
| --- | --- |
| both at 5 MiB, or both at 5,000,000 bytes | none |
| `tickets` at 5 MiB, `reports` left at 25 MiB (the global-only answer) | refused in reports |
| `reports` at 5 MiB, `tickets` left at 50 MiB | refused in tickets |
| nothing changed | both refusals |
| neither has a limit | both refusals |
| both at 2 MB | accepted, and both refusals as `not run` |

The applied check was run on its own against the same stack: rows that already agree with `config.toml` pass, and a
row left at 50 MiB while `config.toml` declares 5 MiB, or both left stale, fail naming the buckets.

## First baseline

`codex-gpt-6-luna-no-skills`, scored before `the agent applied the bucket settings it wrote` existed, so five checks.
Four runs in two batches: 3/5, then 5/5, 3/5 and 3/5. Every run read the guide.

- **One run passed.** It declared 5MB on the global setting and on both buckets in `config.toml` and applied them.
- **Two runs left `tickets` and `reports` open.** One set only the global limit and restarted. One set the limit on
  all three but never ran `supabase seed buckets`. The page names neither the local file nor the seeding step. One agent's
  docs search did ask for `config.toml`, so it knew to look there.
- **The earlier single run** also set only the global limit, and it is the 3/5 first in the list.

The final scorer was checked on a real stack and not rerun against an agent. With it, the unapplied run above scores
the applied check red and the two refusals green, and the global-only runs go red on `reports` and on the applied
check. Refresh before reading these as the eval's failure mode.

## The guide has to actually be read

`the agent read the file limits guide the prompt referenced` fails unless a docs call returned the page's content. Read
`docs.calls` before the score. An agent that follows the page's link to Creating Buckets reads a different page, and
that counts, because the gap is in this one.

## What this eval does not score

- **A bucket created later.** On a local stack it has no cap whatever the project sets, so no solution could pass a
  check for it. The prompt does not ask for it.
- **The Dashboard setting and the plan caps.** Hosted only.
- **Resumable and S3 uploads, and image transformations.** The page doesn't cover them. The probes use the plain
  upload route.
- **Allowed file types.** The page mentions restricting them. The prompt asks for nothing about types.
- **File name restrictions.** The same page lists them. Not asked for.
- **The exact boundary.** 5 MB is probed at 3 MB and 8 MB, because decimal against binary isn't the page's claim.
- **How the limit was persisted.** `config.toml`, a Storage API call and SQL all land in `storage.buckets`. Whether it
  survives a reset is `build-docs-020`'s kind of claim.

## Risks

- **The probes run through Kong from the scorer.** An 8 MB body goes in twice per run, about 22 MB in all. The agent's
  timeout does not bound the scorer, so the cost is wall-clock.
- **Refresh twice before describing how agents fail.** One baseline's failure mode is not the eval's.
