# build-docs-030-pgvector

## What this eval measures

The [pgvector](https://supabase.com/docs/guides/database/extensions/pgvector) guide, not the agent. The prompt is a
product request plus the page's url, and the checks say whether an agent that read the page ended up with a project
that stores embeddings and returns the closest articles for a search, through the API the help center uses. A gap in
the page counts as a failure.

One claim: **embeddings are stored and searched by similarity.** Three things on the page are what this eval leans on,
each tried on a real local stack (CLI 2.117.0) before any check was written:

- The page's table is `extensions.vector(384)`, the size of one model's output. An app whose embeddings are another
  size gets `expected 384 dimensions, not 8` on every insert, over the API as well as in SQL.
- The page never shows a search an app can call. Its only search is a bare `order by embedding <-> '[3,1,2]'`, and
  the API's table endpoints cannot express that operator, so the app needs a database function.
- The operator lives in the `extensions` schema. A function written with `set search_path = ''`, which Supabase's own
  advisors recommend, fails every call with `operator does not exist: extensions.vector <=> extensions.vector` unless
  the operator is written `operator(extensions.<=>)`. The page says nothing about it.

Checked against the page at supabase/supabase `main` as of 2026-11-24.

## Where the checks came from

No user evidence for this page turned up, which the ticket said to expect.

- **Reached:** the page, and the local stack itself: the page's table at 384 against an 8-number embedding, a search
  function with an empty search path against the extension's operator, and PostgREST's view of a function created a
  moment earlier (it answers `PGRST202` for about a second) were each tried before any check was written.
- **Out of reach:** Linear, Slack, Hex, the internal report.

`build-vectors-001-rag-with-permissions` (benchmark) is the nearest existing eval. It is MCP, hosted, and about
row-level permissions on a RAG search. This one is the guide's own claim, on the local stack.

## Do not reintroduce the vocabulary

Keep all of these out of `PROMPT.md`:

vector, embedding, pgvector, extension, similarity, cosine, distance, nearest neighbor, index, HNSW, IVFFlat, `<->`,
dimension, rpc, function, semantic.

"Search", "closest in meaning" and "numbers" stay, because they are the user's words.

## The seed carries the contract

- `local/app/embed.mjs` is the stand-in for a real model, so the project runs offline. It gives 8 numbers per text,
  not 384, so the page's size is wrong for this project and a memorized answer fails. The scorer has its own copy of
  the same function in `probes.ts`: keep the two in step.
- `local/app/search.mjs` fixes what the app calls: `match_articles(query_embedding, match_count)` over the API with
  the public key, rows with `id` and `title`, closest first, and a column called `embedding` on `articles` made from
  the article's body. This is the discovery question the eval gives up for an observable answer.
- `local/supabase/migrations/20240101000000_create_articles.sql` has six articles with no embeddings, so the agent has
  to fill them in as well as store new ones.
- `services: gotrue, kong, postgrest`, because the search goes over the API. `kong` does not come up without
  `postgrest`.

## Do not drop the positive controls

- `an article added with its embedding comes back when searching for that embedding` is the control for the next two.
  The scorer adds three articles after the agent is done, with a marker in the title and numbers no seeded article is
  near, so nothing the agent wrote can satisfy it. When it fails, the two after it fail with a `not run` note.
- `the closest article comes first, then the next closest` needs all three of them back in order. Farthest-first fails
  it. The three are unit vectors, so any of the three operators the page names ranks them the same.
- `the articles that were already in the project are found by their own text` searches with what `embed()` gives for
  each seeded article's body and requires that article first. It runs before the scorer adds a row of its own, and it
  is the check that fails when the seeded articles were never given embeddings.
- The scorer calls the function over the API by name, with the two arguments, the way `search.mjs` does. A function
  with another name, argument name or extra required argument fails the contract.
- A not-found answer is asked again for up to eight seconds, because PostgREST reloads its view of the database a
  moment after a function appears. The wait is shared, so a missing function costs one wait, not eight.

## Predicted to saturate, and what failed

The probes ran against a real local stack with example solutions, kept local and never committed. Predictions were
written before running and all held.

| Solution | Red checks |
| --- | --- |
| extension in `extensions`, 8-number column, backfill, an invoker function ordered by `<=>` | none |
| the page's `vector(384)` | all four |
| the function has `set search_path = ''` and an unqualified `<=>` | all four |
| ordered farthest first | `order`, `existing` |
| the count ignored (`limit 5`) | `count` |
| nothing backfilled | `existing` |
| nothing built | all four |

The signal is in the dimension, the operator and the backfill. An agent that sizes the column to the app's numbers,
backfills, and qualifies the operator passes everything, which is a correct answer and not a defect.

## First baseline

`codex-gpt-6-luna-no-skills`, three runs: **6 of 6 checks each time**. All three read the guide, sized the column to
the seed's 8 numbers (from `embed.mjs`, not the page's 384), backfilled the six articles, and wrote a function the API
could call. Two of the three used `set search_path = ''` and qualified the operator as `operator(extensions.<=>)`; the
third left the search path alone. None of them hit the page's gaps, because the seed tells them the size and the model
already knows the operator trap. The failing shapes are real and the example solutions above red them, so a weaker
model or an agent working from the page alone would show them.

So this claim holds for the model on this page, and the eval is saturated for it. A pass says the page works for a
model that reads it, which is a correct answer and not a defect. One refresh is a signal, not proof.

## The guide has to actually be read

`the agent read the pgvector guide the prompt referenced` fails unless a docs call returned the page's content. Read
`docs.calls` before the score. Reading the page and knowing Postgres produce the same result on a mainstream task, so
a pass doesn't attribute the work to the page.

## What this eval does not score

- **Filtered queries on an index.** The page's one specific warning is that an HNSW or IVFFlat index with a filter can
  return fewer rows than asked, and iterative scans fix it. It depends on the planner choosing the index, so a small
  table would read as a pass for the wrong reason. The prompt asks for nothing about speed either.
- **Indexes at all** (`hnsw`, `ivfflat`) and which distance operator is used. Any approach that returns the closest
  articles first passes.
- **Generating real embeddings.** The page's Transformers.js example is not run. The seed's `embed()` stands in.
- **A threshold on how close is close enough.** The search is asked for the closest N and shows whatever comes back.
- **Row-level security on `articles`.** That is the RLS guide's claim. A table the public key cannot read fails the
  search, with the API's error in the note.
- **How the change was persisted.** The scorer applies pending migrations first and gives that its own check, so a
  function created straight in the database passes. Whether it survives a reset is the migrations guide's claim.
