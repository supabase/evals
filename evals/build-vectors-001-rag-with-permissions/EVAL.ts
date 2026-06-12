import type {
  CheckResult,
  SupabaseClient,
  ToolEvalContext,
  ToolScorer,
} from "@supabase-evals/core";
import { stripIndent } from "common-tags";

const PASSWORD = "secret123";

const DIM = 384;

// Normalized embedding with the given (axis, weight) components. Normalized
// vectors order identically under cosine, inner product, and L2, so the
// search checks hold for whichever metric the agent picked.
function embedding(components: Array<[number, number]>): string {
  const v: number[] = new Array(DIM).fill(0);
  for (const [axis, weight] of components) v[axis] = weight;
  const norm = Math.hypot(...v);
  return `[${v.map((x) => (x === 0 ? "0" : (x / norm).toFixed(6))).join(",")}]`;
}

const QUERY_EMBEDDING = embedding([[0, 1]]);

// Embeddings for the seeded document_sections, keyed by id (insert order in
// seed/project.sql). Sections 1-2 belong to doc 1 (user A), 3-4 to doc 2
// (user B). Section 3 is the *global* nearest neighbor to the query — if
// anything bypasses RLS it shows up as user A's top search result.
const SECTION_EMBEDDINGS: Array<[number, string]> = [
  [1, embedding([[0, 0.9], [1, 0.1]])],
  [2, embedding([[1, 1]])],
  [3, embedding([[0, 1]])],
  [4, embedding([[0, 0.6], [2, 0.8]])],
];
const LEAK_CANARY_SECTION = 3;

// pgvector pairs each distance operator with an index operator class; an
// index built with a different opclass is silently ignored by the planner.
// https://supabase.com/docs/guides/ai/vector-indexes
const OPERATOR_OPCLASS: Array<[string, string]> = [
  ["<#>", "vector_ip_ops"],
  ["<=>", "vector_cosine_ops"],
  ["<->", "vector_l2_ops"],
];

const scorer: ToolScorer = async (ctx) => {
  try {
    const setup = await setupUsersAndEmbeddings(ctx);
    if ("failure" in setup) {
      return { passed: false, checks: [setup.failure] };
    }
    const users = setup.users;

    const checks: CheckResult[] = [
      await checkEmbeddingColumn(ctx),
      await checkHnswIndex(ctx),
      await checkIndexMatchesSearchOperator(ctx),
      await checkSearchIsolation(ctx, "user A", users.userAId, [1, 2]),
      await checkSearchIsolation(ctx, "user B", users.userBId, [3, 4]),
      await checkUserAReadsOwnSections(users),
      await checkUserAReadsOwnDocuments(users),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [{ name: "scorer evaluated vector search", passed: false, notes: msg }],
    };
  }
};

export default scorer;

type TestUsers = {
  clientA: SupabaseClient;
  userAId: string;
  userBId: string;
};

async function setupUsersAndEmbeddings(
  ctx: ToolEvalContext,
): Promise<{ users: TestUsers } | { failure: CheckResult }> {
  const clientA = ctx.client;
  const authA = await clientA.auth.signUp({
    email: "vector-user-a@example.com",
    password: PASSWORD,
  });
  const authB = await ctx.getClient().auth.signUp({
    email: "vector-user-b@example.com",
    password: PASSWORD,
  });

  if (authA.error || authB.error || !authA.data.user?.id || !authB.data.user?.id) {
    return {
      failure: {
        name: "created auth sessions",
        passed: false,
        notes: authA.error?.message ?? authB.error?.message ?? "missing session",
      },
    };
  }

  // Hand the seeded documents to the signed-up users: doc 1 → A, doc 2 → B.
  await ctx.query(stripIndent`
    UPDATE documents SET owner_id = '${authA.data.user.id}' WHERE id = 1;
    UPDATE documents SET owner_id = '${authB.data.user.id}' WHERE id = 2;
  `);

  // Backfill section embeddings the way the app would. Skipped silently if
  // the agent never added the column — checkEmbeddingColumn reports that.
  try {
    for (const [id, value] of SECTION_EMBEDDINGS) {
      await ctx.query(`UPDATE document_sections SET embedding = '${value}' WHERE id = ${id};`);
    }
  } catch {
    // ignore: column missing
  }

  return {
    users: { clientA, userAId: authA.data.user.id, userBId: authB.data.user.id },
  };
}

async function checkEmbeddingColumn(ctx: ToolEvalContext): Promise<CheckResult> {
  // format_type renders the column's declared type, e.g. "extensions.vector(384)"
  const { rows } = await ctx.query(stripIndent`
    SELECT format_type(atttypid, atttypmod) AS column_type FROM pg_attribute
    WHERE attrelid = 'document_sections'::regclass
      AND attname = 'embedding' AND NOT attisdropped;
  `);
  const columnType = rows[0]?.column_type;

  return {
    name: "document_sections.embedding is vector(384)",
    passed: typeof columnType === "string" && /(^|\.)vector\(384\)$/.test(columnType),
    notes: typeof columnType === "string" ? columnType : "no embedding column",
  };
}

// Index definitions on the embedding column as readable SQL, e.g.
// "CREATE INDEX ... USING hnsw (embedding vector_ip_ops)"
// https://www.postgresql.org/docs/current/view-pg-indexes.html
async function getEmbeddingIndexDefs(ctx: ToolEvalContext): Promise<string[]> {
  const { rows } = await ctx.query(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'document_sections';`,
  );
  return rows
    .flatMap((row) => (typeof row.indexdef === "string" ? [row.indexdef] : []))
    .filter((def) => def.includes("(embedding"));
}

async function checkHnswIndex(ctx: ToolEvalContext): Promise<CheckResult> {
  const defs = await getEmbeddingIndexDefs(ctx);

  return {
    name: "HNSW index on the embedding column",
    passed: defs.some((def) => def.includes("USING hnsw")),
    notes: defs.join("; ") || "no index on embedding column",
  };
}

async function checkIndexMatchesSearchOperator(
  ctx: ToolEvalContext,
): Promise<CheckResult> {
  const name = "index operator class matches the search operator";
  // pg_get_functiondef returns the full CREATE FUNCTION source.
  // https://www.postgresql.org/docs/current/functions-info.html
  const { rows } = await ctx.query(stripIndent`
    SELECT pg_get_functiondef(oid) AS def FROM pg_proc
    WHERE proname = 'match_document_sections';
  `);
  const fnDef = rows[0]?.def;
  if (typeof fnDef !== "string") {
    return { name, passed: false, notes: "match_document_sections not found" };
  }

  const used = OPERATOR_OPCLASS.filter(([operator]) => fnDef.includes(operator));
  const defs = await getEmbeddingIndexDefs(ctx);

  return {
    name,
    passed: used.length === 1 && defs.some((def) => def.includes(used[0][1])),
    notes: stripIndent`
      function operators: ${used.map(([operator]) => operator).join(", ") || "none"}
      indexes: ${defs.join("; ") || "none"}
    `,
  };
}

// Runs the search function as a signed-in user via the docs' direct-Postgres
// impersonation pattern (supabase-lite doesn't route PostgREST rpc yet).
// https://supabase.com/docs/guides/ai/rag-with-permissions#direct-postgres-connection
async function checkSearchIsolation(
  ctx: ToolEvalContext,
  label: string,
  userId: string,
  expectedSectionIds: number[],
): Promise<CheckResult> {
  const name = `${label} search returns only own sections, best match first`;
  await ctx.query(`SET ROLE authenticated;`);
  await ctx.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
  try {
    // Named arguments, mirroring how the seeded search function calls the rpc.
    const { rows } = await ctx.query(
      `SELECT * FROM match_document_sections(query_embedding => '${QUERY_EMBEDDING}', match_count => 10);`,
    );
    // The seeded search function passes results straight back to the app, so
    // any row shape works as long as it identifies the section.
    const ids = rows.map((row) => Number(row.id ?? row.section_id));
    const leaked =
      ids.includes(LEAK_CANARY_SECTION) && !expectedSectionIds.includes(LEAK_CANARY_SECTION);

    return {
      name,
      passed: ids.join(",") === expectedSectionIds.join(","),
      notes: leaked ? "leak: another user's section is in the results" : undefined,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  } finally {
    await ctx.query(`RESET ROLE;`);
    await ctx.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
  }
}

async function checkUserAReadsOwnSections(users: TestUsers): Promise<CheckResult> {
  const sections = await users.clientA.from("document_sections").select("id");
  const ids = (sections.data ?? []).map((row) => Number(row.id)).sort();

  return {
    name: "user A reads only own sections through the API",
    passed: !sections.error && ids.join(",") === "1,2",
    notes: sections.error?.message,
  };
}

async function checkUserAReadsOwnDocuments(users: TestUsers): Promise<CheckResult> {
  const docs = await users.clientA.from("documents").select("id");
  const ids = (docs.data ?? []).map((row) => Number(row.id));

  return {
    name: "user A reads only own documents through the API",
    passed: !docs.error && ids.join(",") === "1",
    notes: docs.error?.message,
  };
}
