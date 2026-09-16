# build-docs-008-storage-access-control

## What this eval measures

The subject is [Storage Access Control](https://supabase.com/docs/guides/storage/security/access-control), not the
agent. The prompt is a product request plus the page's url, and the checks say whether an agent that read the page
produced working code. A gap in the page counts as a failure here.

One claim: a picture that belongs to one person is reachable by that person and by nobody else, over the API the app
actually calls.

The page teaches policies on `storage.objects`. It does not say that a public bucket serves every object it holds
regardless of those policies. The checks are arranged so that a page-faithful policy set on a private bucket passes,
and the same policies on a public bucket fail.

## Do not reintroduce the vocabulary

The prompt names the feature and the requirement. It never names the mechanism, because whether the page transmits
the mechanism is the measurement. Keep all of these out of `PROMPT.md`:

bucket, private, public, RLS, row level security, policy, policies, `storage.objects`, `storage.foldername`,
`owner_id`, `auth.uid`, `auth.jwt`, signed url, service role, secret key, permission, grant, access control,
authenticated, anon, folder, listing.

The seed may carry product vocabulary the user would already have in front of them. The line is the prompt.

## The seed carries the contract

`local/supabase/migrations/20240101000000_init.sql` is the app's existing schema. Two things in it are load-bearing.

- **The file naming.** The comment on `profiles.picture_file` fixes the object name as `<profiles.id>/<picture_file>`,
  attributed to two clients that already build it that way. Without an agreed name the scorer has no address to
  upload to, and the prompt would have to describe the layout instead. It buys a probeable address at the cost of a
  discovery question, and that trade is deliberate.
- **The pre-solved tables.** `profiles` and `notes` arrive with row level security on and owner-scoped policies, and
  the comment says their rules are settled. Table policies are the subject of `build-docs-002-rls-guide`, so a
  mistake there cannot fail this eval for the wrong reason.

The bucket name is **not** seeded. A fresh local stack has no buckets, so every row in `storage.buckets` is the
agent's, whichever route it took: a migration, `storage.buckets` by hand, `[storage.buckets.<name>]` in
`config.toml`, or `createBucket` from a client. All four land in the same table, which is what the checks read.
`pickProbeBucket` drives the one whose name reads like the feature and falls back to the oldest, and names its choice
in every note.

The prompt says the app talks to Supabase from the browser with no server in between. That closes a reading rather
than hinting: an agent that put every read behind its own server holding the secret key would satisfy the
requirement while failing `the owner can read their own profile picture back`, and the prompt has to say which
design it wants rather than letting a check decide.

## How the scorer is ordered

Pending migrations apply first. `supabase migration up --local` runs before anything is read, and
`the agent applied the migrations it wrote` reds when there was something to apply.

That split is what keeps the page's signal readable. An agent that writes correct SQL and never applies it leaves
`storage.buckets` empty, which would otherwise red the bucket check and all eight probes together for an
operational step this page says nothing about. Applying first costs that agent one check instead of nine.

`migration up` rather than `db reset`, because a reset would discard a bucket the agent created at runtime through
a client or by hand, and both are correct answers.

The catalog reads next. Every probe stores an object, so the bucket and row level security checks have to describe
what the agent left behind rather than what the scorer added to it.

The probes then drive the Storage API through a client rather than inserting into `storage.objects`. The API is what
the app calls and what the prompt's second clause is about, and a direct insert would satisfy policies the API path
rejects and would not exercise public-bucket delivery at all.

`another signed-in person cannot write into the owner's own area` runs last, because it stores an object under the
owner's prefix when the policies allow it and both listing probes read that prefix.

## Do not drop the positive controls

`another signed-in person cannot read the owner's profile picture`, `a signed-out visitor cannot read the owner's
profile picture` and `another signed-in person cannot list the owner's profile pictures` all pass for an agent that
created a bucket and wrote nothing else, because with no policies nobody can read anything. What makes them mean
something is `the owner can upload their own profile picture`, `the owner can see their own profile picture listed`
and `the owner can read their own profile picture back`.

**Listing is the positive control a public bucket does not satisfy for free.** A public bucket serves downloads from
its own flag, so `the owner can read their own profile picture back` passes on a public bucket with no read policy
at all, and proves nothing on such a run. Listing goes through `storage.objects` whatever the bucket's flag says, so
the owner can only list their own picture when a read policy admits them. Read those two together.

`the owner's profile picture is not served over the bucket's public url` is the only check that catches a public
bucket carrying correct owner-scoped policies. Storage answers `/object/public/<bucket>/<path>` from the bucket flag
and never consults `storage.objects`, so every policy-shaped check in the file passes while the file is
world-readable. It fetches the url the client library builds rather than one assembled from `stackStatus()`, which
throws when any of its three values is missing.

`another signed-in person cannot list the owner's profile pictures` reads the owner's own prefix and the root of the
bucket. A policy scoped to the bucket and nothing else hides neither, and the root listing is what turns a broad
read policy into every person being able to enumerate everyone's pictures.

`row level security is enabled on storage.objects` is a saturated check. The table ships with it on and no policies,
so it only reds an agent that turned it off to make an upload work.

The refusal checks read the outcome, not the error. `another signed-in person cannot write into the owner's own
area` counts rows as the superuser rather than trusting the API's message, so a request the probe itself malformed
cannot be scored as a refusal. `the owner can upload their own profile picture` does the same in reverse, so a 200
over a request that stored nothing cannot pass.

The marker is scoped to the run, and the owner's id is fresh per run, so nothing a previous run left behind can
satisfy a probe in this one.

## The guide has to actually be read

The last check resolves the guide through the harness's own docs result, because a `search_docs` hit carries the url
in its result rather than its request. It requires retrieved content, not just a url that was reached.

Read `docs.calls` before reading the score. Docs evals run on one experiment and it is a no-skills one, so there is
no second arm to rule out prior knowledge. An empty `docs.calls` means the run measured nothing about the page,
whatever the checks say.

## What this eval does not score

- **Replacing a picture.** Overwriting an object at the same name needs `select` and `update` alongside `insert`,
  which the page states. The prompt does not ask for it and no check measures it, so an agent that adds those
  policies fails nothing.
- **Deleting a picture.** Same reason, and the page carries no `delete` example.
- **Sharing a picture with someone else.** Temporary links are the subject of
  `evals/benchmark/build-storage-001-private-bucket-access`, which asks for them outright.
- **Whether a public bucket should carry policies at all.** The prompt asks for owner-only pictures, where a private
  bucket is unambiguously right, and the checks stay out of the case where a bucket is public on purpose.
- **The operation-aware helpers.** `storage.allow_only_operation()` and `storage.allow_any_operation()` split listing
  from reading on a public bucket, which is the case above.
- **`owner_id` against the path.** Both are the page's own examples and both satisfy every check. A check that
  accepted one of them would constrain the page to a single method.

## A risk worth knowing

**A page-faithful policy set passes.** The guide's per-user upload example paired with its `owner_id` read example
scores every check on a private bucket. The eval is pointed at the bucket rather than at the policies, and a
baseline where agents reach a private bucket unprompted is a baseline where the page is not the binding constraint.

**`the agent applied the migrations it wrote` is the check to watch.** It is the one check that scores the CLI
lifecycle rather than anything the page teaches, and agents red it often. An eval passes only when every check
passes, so correct policies on a correct private bucket still fail overall on that check alone.

**The guide's weaker examples do not compose.** Its bucket-only upload example, `with check (bucket_id =
'my_bucket_id')`, paired with the `owner_id` read example, lets any signed-in person store a file inside someone
else's area. It reds `another signed-in person cannot write into the owner's own area` and nothing else. Both
statements are on the page and nothing on the page separates them.

**`every bucket in the project is private` ranges over every bucket.** An agent that creates a correct private
bucket and an unrelated public one reds it while every probe passes, because a second bucket holding the same
pictures is the leak. The note names which bucket was public.

**A scorer cannot clean up after itself here.** `storage.objects` and `storage.buckets` carry
`protect_objects_delete` and `protect_buckets_delete` triggers, and `postgres` owns neither table. Nothing in this
eval needs to delete anything, because each run gets a fresh stack and run-scoped names, and a check that did would
have to go through the Storage API or connect as `supabase_storage_admin`.
