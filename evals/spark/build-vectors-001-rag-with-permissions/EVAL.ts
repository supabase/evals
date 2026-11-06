import type { CheckResult, ToolScorer } from '@supabase-evals/core';
import { z } from 'zod';

// Spark port of the benchmark build-vectors-001 scenario. Spark has no
// pgvector, RPC, edge functions or vector indexes, so the embeddings are seeded
// as JSON text and the agent adds the vector column, then searches itself. The
// scorer checks the column the agent built and runs the search for both users
// against it, like the original does through its RPC. Ownership is applied in
// the query: the RLS enforcement of the original is not scored until Spark
// supports it.

const SEED_COUNTS = { documents: 3, document_sections: 6 };

// The search the scorer runs against the agent's `embedding` column.
const QUERY = '[1,0,0,0]';
// Alice (user-a) owns sections 1, 2, 5 and 6. Cosine similarity to the query
// ranks them 1 (0.99), 5 (0.71), 6 (0.30), 2 (0).
const EXPECTED_IDS = { 'user-a': [1, 5, 6], 'user-b': [3, 4] };
// user-b's sections. Section 3 is the global nearest neighbour of the query.
const OTHER_USERS_SECTION_IDS = EXPECTED_IDS['user-b'];

const scorer: ToolScorer = async (ctx) => {
  const checks: CheckResult[] = [];
  const attempt = async (name: string, run: () => Promise<CheckResult>) => {
    try {
      checks.push(await run());
    } catch (error) {
      checks.push({
        name,
        passed: false,
        notes: error instanceof Error ? error.message : String(error),
      });
    }
  };

  await attempt('Seed data left unchanged', async () => {
    const counts = await Promise.all(
      Object.keys(SEED_COUNTS).map(async (table) => {
        const { data, error } = await ctx.client
          .from(table)
          .select(
            table === 'document_sections' ? 'id,content,embedding_json' : 'id'
          );
        if (error) throw new Error(`${table}: ${error.message}`);
        const rows = z.array(z.record(z.string(), z.unknown())).parse(data);
        const intact = rows.every((row) =>
          Object.values(row).every((value) => value !== null && value !== '')
        );
        return [table, rows.length, intact] as const;
      })
    );
    return {
      name: 'Seed data left unchanged',
      passed: counts.every(
        ([table, count, intact]) =>
          intact && count === SEED_COUNTS[table as keyof typeof SEED_COUNTS]
      ),
      notes: counts.map(([table, count]) => `${table} ${count}`).join(', '),
    };
  });

  await attempt(
    'Section embeddings are stored as vectors in `embedding`',
    async () => {
      const { rows } = await ctx.query(
        "select id, typeof(embedding) as kind, case when typeof(embedding) = 'blob' then vector_extract(embedding) end as vector, embedding_json as expected from document_sections order by id"
      );
      const parsed = z
        .array(
          z.object({
            id: z.number(),
            kind: z.string(),
            vector: z.string().nullable(),
            expected: z.string(),
          })
        )
        .parse(rows);
      const bad = parsed.filter(
        (row) => row.kind !== 'blob' || !sameVector(row.vector, row.expected)
      );
      return {
        name: 'Section embeddings are stored as vectors in `embedding`',
        passed:
          parsed.length === SEED_COUNTS.document_sections && bad.length === 0,
        notes: bad.length
          ? `sections ${bad.map((row) => `${row.id} (${row.kind})`).join(', ')} are not vectors matching embedding_json`
          : undefined,
      };
    }
  );

  for (const owner of ['user-a', 'user-b'] as const) {
    const name = `Searching ${owner}'s sections with the \`embedding\` column returns their nearest first`;
    await attempt(name, async () => {
      const { rows } = await ctx.query(
        `select s.id from document_sections s join documents d on d.id = s.document_id where d.owner_id = '${owner}' order by vector_distance_cos(s.embedding, vector32('${QUERY}')) limit 3`
      );
      const ids = z
        .array(z.object({ id: z.number() }))
        .parse(rows)
        .map((row) => row.id);
      return {
        name,
        passed: JSON.stringify(ids) === JSON.stringify(EXPECTED_IDS[owner]),
        notes: `expected ${JSON.stringify(EXPECTED_IDS[owner])}, got ${JSON.stringify(ids)}`,
      };
    });
  }

  const actual = parseIds(ctx.agentReport ?? '');
  checks.push({
    name: 'Reply contains the section ids as a JSON array',
    passed: actual !== undefined,
    notes: actual
      ? undefined
      : (ctx.agentReport ?? '').replace(/\s+/g, ' ').slice(0, 160),
  });
  checks.push({
    name: "Alice's 3 nearest sections are returned, most similar first",
    passed: JSON.stringify(actual) === JSON.stringify(EXPECTED_IDS['user-a']),
    notes: `expected ${JSON.stringify(EXPECTED_IDS['user-a'])}, got ${JSON.stringify(actual)}`,
  });
  checks.push({
    name: "Other users' sections are not returned",
    passed:
      !!actual && !actual.some((id) => OTHER_USERS_SECTION_IDS.includes(id)),
  });

  return { passed: checks.every((check) => check.passed), checks };
};

export default scorer;

/** Whether two JSON number arrays hold the same values, ignoring float formatting. */
function sameVector(a: string | null, b: string): boolean {
  if (a === null) return false;
  try {
    const left: unknown = JSON.parse(a);
    const right: unknown = JSON.parse(b);
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every(
        (value, index) =>
          typeof value === 'number' &&
          typeof right[index] === 'number' &&
          Math.abs(value - right[index]) < 1e-6
      )
    );
  } catch {
    return false;
  }
}

/** The id array from the agent's reply: a fenced block first, else the outermost brackets. */
function parseIds(reply: string): number[] | undefined {
  const candidates = [
    ...[...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]),
    reply.slice(reply.indexOf('['), reply.lastIndexOf(']') + 1),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = z.array(z.number()).safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {}
  }
  return undefined;
}
