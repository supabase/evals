# resolve-vectors-001-search-returns-too-few-results

Tests whether an agent can diagnose and fix semantic search that silently returns too few results for users who own a small share of the table.

## Setup

`remote/project.sql` follows the schema and policies in the [RAG with Permissions guide](https://supabase.com/docs/guides/ai/rag-with-permissions): ownership lives on `documents`, and `document_sections` are visible through their document. It adds an HNSW index and a plain `match_document_sections` function, then seeds 10,000 sections in 1,250 documents. Embeddings are synthetic, clustered into 50 topics, and fixed by `setseed`.

The scorer signs up two users and hands them the seeded documents:

| User | Documents | Sections |
|---|---|---|
| Small customer | 12 | 96 (about 1%) |
| Large team | 1,238 | 9,904 |

## Why search comes up short

pgvector applies filters after the HNSW scan, and RLS is a filter. The index returns its nearest `hnsw.ef_search` (40) sections across all users, then the policy removes the ones the user doesn't own. For the small customer few or none survive, with no error. The large team is unaffected, which is why the prompt says search "works fine" for them.

## Checks

The scorer runs 10 fixed searches as each user and compares them with an exact scan of the sections that user owns.

- The small customer gets 10 results for every search.
- Those results include the true nearest sections, with recall@10 of at least 0.7. HNSW is approximate and its graph differs between boots, so valid fixes score from about 0.8 to 1.0; the floor only rejects results that aren't the nearest at all.
- Results come back best match first, checked against distances recomputed from the stored embeddings.
- The large team still gets full, correct, ordered results.
- Neither user sees another user's sections, in search or through direct API reads.
- The HNSW index is kept, and RLS stays enabled on both tables.

The checks look at results, not at how the fix was made.

## Known solutions

`EVAL.test.ts` boots the seed and scores each candidate fix with the real scorer:

| Fix | Result |
|---|---|
| Unchanged seed | Fails: small customer gets too few, wrong results |
| Filter on the user's documents in the query, btree indexes on `document_sections (document_id)` and `documents (owner_id)`, `hnsw.iterative_scan = relaxed_order`, and pgvector's materialized CTE re-sort | Passes |
| `relaxed_order` without a re-sort | Fails: results out of order |
| `relaxed_order` with a re-sort written `ORDER BY distance`, as agents tried in local runs | Fails: Postgres 17 skips the re-sort, so results are out of order. Passes with `ORDER BY distance + 0` |
| `strict_order` | Passes: recall 0.80 to 0.89 across boots, above the 0.7 floor |
| Returning the user's own sections ordered by id | Fails: not the nearest sections |
| Dropping the HNSW index | Fails: index removed |
| `SECURITY DEFINER` function | Fails: leaks other users' sections |
| Disabling RLS | Fails: RLS disabled, leaks |

Raising `hnsw.ef_search` far enough also passes at this table size, likely because pgvector's cost estimate then steers the planner to an exact scan. That is a legitimate fix here, though it doesn't scale.

Run the tests with:

```bash
pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/regression/resolve-vectors-001-search-returns-too-few-results/EVAL.test.ts
```

Each case boots a fresh project and builds the HNSW index, so the file takes several minutes.

The same failure and fix were measured at larger scale, on a hosted project with 57,600 real embeddings, in [filtered-retrieval-bench](https://github.com/MishallAshraf/filtered-retrieval-bench).
