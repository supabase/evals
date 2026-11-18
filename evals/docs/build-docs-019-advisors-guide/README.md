# build-docs-019-advisors-guide

## What this eval measures

The subject is [Advisors](https://supabase.com/docs/guides/observability/advisors), not the agent. The prompt is a
product request plus the page's url, and the checks say whether an agent that read the page left the flagged
findings fixed rather than hidden. A gap in the page counts as a failure here.

One claim: after the cleanup, the unindexed foreign key findings are gone because each relationship has a covering
index, and every relationship still holds.

The trap is a swap between two lints. Adding the index that clears `unindexed_foreign_keys` creates an index with
no scans, which `unused_index` flags at once. An agent that compares totals sees no progress. An agent that follows
the second finding drops the index, and the first finding comes back. An agent that wants both gone can drop the
relationship instead.

Both lints are INFO level. At its default `--level warn`, `supabase db advisors --local` shows only the four
`rls_disabled_in_public` errors on the seed and no performance finding at all. At `--level info` it shows three
`unindexed_foreign_keys` and one `unused_index`, and after a correct fix it shows four `unused_index`, so the
performance total does not move. Verified on CLI 2.122.0.

## Do not reintroduce the vocabulary

The prompt names the tables and asks for the findings to be sorted out. It never names the mechanism. Keep all of
these out of `PROMPT.md`:

advisor, advisors, lint, index, indexes, foreign key, constraint, covering, unused, unindexed, `--level`, info.

The seed migration is the world the user already has, so it uses `references` and `create index` as any schema
would.

## The seed carries the contract

`local/supabase/migrations/20240101000000_init.sql` is a physio booking app with three findings:
`practitioners.clinic_id`, `appointments.practitioner_id`, and the two-column link from `appointments` to `rooms`.
Two things in it are load-bearing.

- **The room link has two columns, `(clinic_id, room_code)`.** The lint only counts an index whose leading columns
  match the link's columns in order. An index on `clinic_id` alone, or on `(room_code, clinic_id)`, leaves the
  finding in place.
- **`appointments_room_calendar` on `(room_code, starts_at)` looks related and does not cover the room link.** It is
  also flagged as unused on a fresh database. Dropping it or keeping it are both accepted.

The comment on `appointments` says a practitioner sees many patients a day in the same room. That rules out a unique
index as the fix, and `a practitioner can hold two appointments in the same room` scores it.

`services: []`, because only Postgres is needed.

## The prompt's migration rule has two checks

"Make the change in the repo's migrations and apply it to the local database" is measured by:

- `the agent applied the migrations it wrote`. Every migration file on disk has a row in the local migration
  history. The scorer applies anything still pending first, so an unapplied migration costs this check rather than
  all of them (flakiness #292).
- `replaying the repo's migrations on an empty schema clears the findings`. In one rolled-back transaction the scorer
  drops `public`, drops any table or view named after a seeded table in another non-system schema, replays every
  migration file in version order, and reruns the findings and table checks. This is what proves the fix lives in
  the repo and not only in the running database. A fix applied by hand next to a stub migration fails it. Adding a
  new migration and editing the init migration followed by a reset both pass, because the app has not launched and
  the prompt allows either.

Whole-line transaction control (`begin;`, `commit;` and similar) is stripped from each file before the replay,
because the replay is already one transaction. Two correct migrations still fail the replay, and the note names the
file: `create index concurrently`, which cannot run in a transaction, and `create extension` without `if not exists`
for an extension the stack already has.

## Phase order

1. Apply pending migrations, so the catalog reads the agent's final schema. This writes to the database, so scoring
   the same stack twice turns an unapplied migration from red to green on the second pass. Score once per stack.
2. Read the unused-index findings for the report check, before the probe's inserts can give an index a scan.
3. Check that the seeded tables are ordinary tables in `public`, then read the foreign key findings. Both are reads.
4. Run the probe. It builds a clinic, a room and a practitioner with a run-scoped marker, attempts four inserts, and
   rolls everything back.
5. Replay the migrations, also rolled back. It runs last because it drops `public` inside its transaction.

## Do not drop the positive controls

`no relationship is flagged as missing a covering index` passes for an agent that dropped every relationship.
`every seeded relationship still refuses a row that points nowhere` is what stops that. It requires `23503` for each
of the three, so a refusal caused by something else, such as a schema the agent changed, does not count (flakiness
#264). A table moved out of `public` fails both probe checks, with `42P01` in their notes. When the probe cannot
build its clinic at all, both fail with a `not run` note.

`a practitioner can hold two appointments in the same room` is the positive control for the probe. It proves the
inserts the refusals are compared against can succeed.

`the seeded tables are still ordinary tables in public` closes a route the lint mirror cannot see. The lint skips
`extensions`, so moving `practitioners` and `appointments` there behind auto-updatable `public` views clears every
finding with no index added, and the probe still gets `23503` through the views.

The live checks and the replay disagree in one case on purpose. Indexes appended to the already-applied init
migration, with no reset, pass the replay and `the agent applied the migrations it wrote`, because that version is
already recorded, and fail `no relationship is flagged as missing a covering index`. The change is in the repo and
not in the database.

## The report check is a judge, scoped to one claim

The prompt asks the agent to say what the checks show once it is done. An agent that runs `supabase db advisors` at
the default level gets "No issues found" before and after the fix, while the unused-index findings remain at INFO
level. Passing that output on to the user is the failure supabase/agent-skills#639 describes.

`the report mentions the unused-index findings that remain` gives a judge the agent's final message and the ground
truth: the unused-index findings the scorer reads from `pg_stat_user_indexes` with the `unused_index` lint
predicate, limited to `public`. The judge passes a report that says, in any words, that indexes are flagged as unused.
It fails one that calls the checks clean or leaves the remaining findings out. When none remain, it passes unless
the report invents some. It does not grade the fix, other lints, tone, or length, and a close call passes. No final
message fails the check.

A query the agent ran itself can give a new index a scan, which clears its `unused_index` finding. The ground truth
reads the state after the agent's work, so the judge grades the report against what is actually left.

## The guide has to actually be read

`the agent read the advisors guide the prompt referenced` requires a docs call that reached the page with content.
Read `docs.calls` before reading a score. An empty one means the run measured the model, not the page.

## What this eval does not score

- **Whether the agent ran the advisors, and at which level.** The checks read the end state. The finding check
  mirrors the `unindexed_foreign_keys` lint predicate in SQL, so it reports what the advisors would show.
- **`unused_index` findings in the schema.** One on each new index is expected, and no check fails on them. They are
  the report check's ground truth. Dropping or keeping `appointments_room_calendar` is allowed.
- **The total finding count.** It does not drop on a correct fix.
- **Running queries to give a new index a scan.** It clears the `unused_index` finding without changing the schema.
  The report check reads the findings after it, so a report that says none remain is then accurate.
- **The `rls_disabled_in_public` errors.** The prompt asks about performance findings. Enabling row level security
  is accepted, and so is forcing it, because the probe connects as `postgres`, which row level security does not
  restrict on the local stack. Leaving it off is accepted too.
- **Partial or expression indexes.** The lint counts any valid index whose leading columns match, and so does this
  check.
