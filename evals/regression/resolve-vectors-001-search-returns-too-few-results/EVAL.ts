import type {
  CheckResult,
  SupabaseClient,
  ToolEvalContext,
  ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

const PASSWORD = 'secret123';
const MATCH_COUNT = 10;
// HNSW is approximate and its graph differs from boot to boot, so valid fixes
// land anywhere from about 0.8 (strict_order) to 1.0. This floor only rejects
// results that aren't the user's nearest sections at all.
const MIN_RECALL = 0.7;

// Placeholder owners in remote/project.sql. The small customer owns documents
// 100, 200, ..., 1200 (96 sections, about 1% of the table); the large team owns
// the rest.
const SMALL_PLACEHOLDER = '00000000-0000-0000-0000-00000000000a';
const LARGE_PLACEHOLDER = '00000000-0000-0000-0000-00000000000b';
const SMALL_DOCUMENT_COUNT = 12;
const SMALL_SECTION_COUNT = 96;

// Searches use stored section embeddings as the query, so they are fixed by the
// seed. The first six are the small customer's own sections, the rest belong to
// the large team. Section (doc - 1) * 8 + part is part `part` of document `doc`.
const QUERY_SECTION_IDS = [
  793, 1597, 2397, 4797, 7195, 9600, 1, 2500, 5003, 9999,
];

type Search = { ids: number[]; error?: string };
type User = { label: string; client: SupabaseClient; id: string };

const scorer: ToolScorer = async (ctx) => {
  try {
    const setup = await setupUsers(ctx);
    if ('failure' in setup) {
      return { passed: false, checks: [setup.failure] };
    }
    const { small, large } = setup;

    const queries = await loadQueryEmbeddings(ctx);
    const smallSearches = await runSearches(small.client, queries);
    const largeSearches = await runSearches(large.client, queries);

    const checks: CheckResult[] = [
      checkFullResults(small, smallSearches),
      await checkMatchesExact(ctx, small, queries, smallSearches),
      await checkBestFirst(ctx, small, queries, smallSearches),
      await checkLargeUserUnaffected(ctx, large, queries, largeSearches),
      await checkNoLeaks(ctx, [
        [small, smallSearches],
        [large, largeSearches],
      ]),
      await checkApiReadsIsolated(small),
      await checkHnswIndex(ctx),
      await checkRlsEnabled(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        { name: 'scorer evaluated vector search', passed: false, notes: msg },
      ],
    };
  }
};

export default scorer;

async function setupUsers(
  ctx: ToolEvalContext
): Promise<{ small: User; large: User } | { failure: CheckResult }> {
  const smallClient = ctx.client;
  const largeClient = ctx.getClient();
  const authSmall = await smallClient.auth.signUp({
    email: 'small-customer@example.com',
    password: PASSWORD,
  });
  const authLarge = await largeClient.auth.signUp({
    email: 'large-team@example.com',
    password: PASSWORD,
  });
  const smallId = authSmall.data.user?.id;
  const largeId = authLarge.data.user?.id;

  if (authSmall.error || authLarge.error || !smallId || !largeId) {
    return {
      failure: {
        name: 'created auth sessions',
        passed: false,
        notes:
          authSmall.error?.message ??
          authLarge.error?.message ??
          'missing session',
      },
    };
  }

  // Hand the seeded documents to the signed-up users, then refresh planner
  // statistics as autovacuum would after a bulk ownership change.
  await ctx.query(stripIndent`
    UPDATE documents SET owner_id = '${smallId}' WHERE owner_id = '${SMALL_PLACEHOLDER}';
    UPDATE documents SET owner_id = '${largeId}' WHERE owner_id = '${LARGE_PLACEHOLDER}';
    ANALYZE documents;
    ANALYZE document_sections;
  `);

  return {
    small: { label: 'small customer', client: smallClient, id: smallId },
    large: { label: 'large team', client: largeClient, id: largeId },
  };
}

async function loadQueryEmbeddings(ctx: ToolEvalContext): Promise<string[]> {
  const { rows } = await ctx.query(stripIndent`
    SELECT id, embedding::text AS embedding FROM document_sections
    WHERE id IN (${QUERY_SECTION_IDS.join(',')});
  `);
  const byId = new Map(
    rows.map((row) => [Number(row.id), String(row.embedding)])
  );
  return QUERY_SECTION_IDS.map((id) => {
    const embedding = byId.get(id);
    if (!embedding) throw new Error(`seeded section ${id} is missing`);
    return embedding;
  });
}

async function runSearches(
  client: SupabaseClient,
  queries: string[]
): Promise<Search[]> {
  const searches: Search[] = [];
  for (const query of queries) {
    const { data, error } = await client.rpc('match_document_sections', {
      query_embedding: query,
      match_count: MATCH_COUNT,
    });
    searches.push(
      error
        ? { ids: [], error: error.message }
        : {
            ids: ((data ?? []) as Array<{ id: number }>).map((row) =>
              Number(row.id)
            ),
          }
    );
  }
  return searches;
}

// The true nearest sections the user owns, by exact scan. Index scans are
// disabled so the answer can't inherit the same shortfall being tested.
async function exactNearest(
  ctx: ToolEvalContext,
  ownerId: string,
  query: string
): Promise<number[]> {
  const { rows } = await ctx.query(stripIndent`
    BEGIN;
    SET LOCAL enable_indexscan = off;
    SET LOCAL enable_bitmapscan = off;
    SELECT s.id FROM document_sections s JOIN documents d ON d.id = s.document_id
    WHERE d.owner_id = '${ownerId}'
    ORDER BY s.embedding <#> '${query}', s.id
    LIMIT ${MATCH_COUNT};
    COMMIT;
  `);
  return rows.map((row) => Number(row.id));
}

function searchErrors(searches: Search[]): string | undefined {
  const errors = searches.flatMap((search) =>
    search.error ? [search.error] : []
  );
  return errors.length ? `rpc error: ${errors[0]}` : undefined;
}

function checkFullResults(user: User, searches: Search[]): CheckResult {
  const counts = searches.map((search) => search.ids.length);
  return {
    name: `${user.label} gets ${MATCH_COUNT} results for every search`,
    passed: !searchErrors(searches) && counts.every((n) => n === MATCH_COUNT),
    notes: searchErrors(searches) ?? `results per search: ${counts.join(', ')}`,
  };
}

async function recallAgainstExact(
  ctx: ToolEvalContext,
  user: User,
  queries: string[],
  searches: Search[]
): Promise<number> {
  let found = 0;
  for (const [i, query] of queries.entries()) {
    const exact = await exactNearest(ctx, user.id, query);
    found += searches[i].ids.filter((id) => exact.includes(id)).length;
  }
  return found / (queries.length * MATCH_COUNT);
}

async function checkMatchesExact(
  ctx: ToolEvalContext,
  user: User,
  queries: string[],
  searches: Search[]
): Promise<CheckResult> {
  const recall = await recallAgainstExact(ctx, user, queries, searches);
  return {
    name: `${user.label} gets the nearest matching sections`,
    passed: !searchErrors(searches) && recall >= MIN_RECALL,
    notes:
      searchErrors(searches) ??
      `recall@${MATCH_COUNT} against exact scan: ${recall.toFixed(3)}`,
  };
}

// Results must come back best match first. Distances are recomputed from the
// stored embeddings, so this holds whatever columns the function returns.
async function unorderedSearches(
  ctx: ToolEvalContext,
  queries: string[],
  searches: Search[]
): Promise<number> {
  let unordered = 0;
  for (const [i, query] of queries.entries()) {
    const ids = searches[i].ids;
    if (ids.length < 2) continue;
    const { rows } = await ctx.query(stripIndent`
      SELECT id, embedding <#> '${query}' AS distance FROM document_sections
      WHERE id IN (${ids.join(',')});
    `);
    const distance = new Map(
      rows.map((row) => [Number(row.id), Number(row.distance)])
    );
    const ordered = ids.every(
      (id, j) =>
        j === 0 ||
        (distance.get(id) ?? 0) >= (distance.get(ids[j - 1]) ?? 0) - 1e-6
    );
    if (!ordered) unordered++;
  }
  return unordered;
}

async function checkBestFirst(
  ctx: ToolEvalContext,
  user: User,
  queries: string[],
  searches: Search[]
): Promise<CheckResult> {
  const unordered = await unorderedSearches(ctx, queries, searches);
  return {
    name: `${user.label} results come back best match first`,
    passed: !searchErrors(searches) && unordered === 0,
    notes:
      searchErrors(searches) ??
      `${unordered} of ${queries.length} searches out of order`,
  };
}

async function checkLargeUserUnaffected(
  ctx: ToolEvalContext,
  user: User,
  queries: string[],
  searches: Search[]
): Promise<CheckResult> {
  const full = searches.every((search) => search.ids.length === MATCH_COUNT);
  const recall = await recallAgainstExact(ctx, user, queries, searches);
  const unordered = await unorderedSearches(ctx, queries, searches);
  return {
    name: `${user.label} search still returns full, correct, ordered results`,
    passed:
      !searchErrors(searches) &&
      full &&
      recall >= MIN_RECALL &&
      unordered === 0,
    notes:
      searchErrors(searches) ??
      `full: ${full}, recall: ${recall.toFixed(3)}, out of order: ${unordered}`,
  };
}

async function checkNoLeaks(
  ctx: ToolEvalContext,
  results: Array<[User, Search[]]>
): Promise<CheckResult> {
  const leaks: string[] = [];
  for (const [user, searches] of results) {
    const ids = [...new Set(searches.flatMap((search) => search.ids))];
    if (ids.length === 0) continue;
    const { rows } = await ctx.query(stripIndent`
      SELECT count(*)::int AS leaked FROM document_sections s JOIN documents d ON d.id = s.document_id
      WHERE s.id IN (${ids.join(',')}) AND d.owner_id <> '${user.id}';
    `);
    const leaked = Number(rows[0]?.leaked ?? 0);
    if (leaked > 0)
      leaks.push(`${user.label} saw ${leaked} sections they don't own`);
  }
  return {
    name: "search never returns another user's sections",
    passed: leaks.length === 0,
    notes: leaks.join('; ') || undefined,
  };
}

async function checkApiReadsIsolated(user: User): Promise<CheckResult> {
  const sections = await user.client.from('document_sections').select('id');
  const documents = await user.client.from('documents').select('id');
  const error = sections.error?.message ?? documents.error?.message;
  const sectionCount = sections.data?.length ?? 0;
  const documentCount = documents.data?.length ?? 0;
  return {
    name: `${user.label} reads only own documents and sections through the API`,
    passed:
      !error &&
      sectionCount === SMALL_SECTION_COUNT &&
      documentCount === SMALL_DOCUMENT_COUNT,
    notes: error ?? `documents: ${documentCount}, sections: ${sectionCount}`,
  };
}

async function checkHnswIndex(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT indexdef FROM pg_indexes
    WHERE tablename = 'document_sections' AND indexdef LIKE '%USING hnsw%(embedding%';
  `);
  return {
    name: 'HNSW index on document_sections.embedding is kept',
    passed: rows.length > 0,
    notes: rows.length
      ? String(rows[0].indexdef)
      : 'no HNSW index on embedding',
  };
}

async function checkRlsEnabled(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT relname, relrowsecurity FROM pg_class
    WHERE relname IN ('documents', 'document_sections') AND relkind = 'r';
  `);
  const disabled = rows
    .filter((row) => row.relrowsecurity !== true)
    .map((row) => row.relname);
  return {
    name: 'row level security stays enabled on documents and sections',
    passed: rows.length === 2 && disabled.length === 0,
    notes: disabled.length ? `disabled on: ${disabled.join(', ')}` : undefined,
  };
}
