import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bootPlatformBackend,
  createJudgeRecorder,
  type ToolEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import scorer from './EVAL.js';

const SEED = join(
  dirname(fileURLToPath(import.meta.url)),
  'remote',
  'project.sql'
);
const SIGNATURE = 'match_document_sections(extensions.vector, int)';

// Each case boots a fresh project from the seed, applies one candidate fix as
// the agent would, then runs the real scorer against it.
async function score(fix: string) {
  const backend = await bootPlatformBackend({
    projectSeedSql: SEED,
    pgvector: true,
  });
  try {
    if (fix) await backend.query(fix);
    const ctx: ToolEvalContext = {
      mgmt: backend.mgmt,
      ref: backend.ref,
      client: backend.client,
      getClient: backend.getClient,
      query: backend.query,
      invokeFunction: backend.invokeFunction,
      toolCalls: [],
      transcript: [],
      judge: createJudgeRecorder().judge,
    };
    const result = await scorer(ctx);
    const failed = (result.checks ?? [])
      .filter((check) => !check.passed)
      .map((check) => check.name);
    return { passed: result.passed, failed };
  } finally {
    await backend.close();
  }
}

// Filter on the user's documents in the query so the planner can use btree
// indexes for small users, keep HNSW with iterative scan for large ones, and
// re-sort because relaxed_order can return rows slightly out of order.
const RECOMMENDED = `
  CREATE INDEX ON document_sections (document_id);
  CREATE INDEX ON documents (owner_id);
  CREATE OR REPLACE FUNCTION match_document_sections(query_embedding extensions.vector (384), match_count int)
  RETURNS TABLE (id bigint, document_id bigint, content text, similarity float)
  LANGUAGE plpgsql STABLE SET hnsw.iterative_scan = relaxed_order AS $$
  BEGIN
    RETURN QUERY
    WITH nearest AS MATERIALIZED (
      SELECT s.id, s.document_id, s.content, s.embedding <#> query_embedding AS distance
      FROM document_sections s
      WHERE s.document_id IN (SELECT d.id FROM documents d WHERE d.owner_id = auth.uid())
      ORDER BY distance LIMIT match_count)
    SELECT nearest.id, nearest.document_id, nearest.content, -nearest.distance
    FROM nearest ORDER BY nearest.distance + 0;
  END $$;
`;

describe('resolve-vectors-001 scorer', { timeout: 180_000 }, () => {
  it('fails the seeded project unchanged', async () => {
    const result = await score('');
    expect(result.passed).toBe(false);
    expect(result.failed).toEqual([
      'small customer gets 10 results for every search',
      'small customer gets the nearest matching sections',
    ]);
  });

  it('passes the recommended fix', async () => {
    expect(await score(RECOMMENDED)).toEqual({ passed: true, failed: [] });
  });

  it('fails relaxed iterative scan without a re-sort', async () => {
    const result = await score(
      `ALTER FUNCTION ${SIGNATURE} SET hnsw.iterative_scan = relaxed_order;`
    );
    expect(result.failed).toContain(
      'small customer results come back best match first'
    );
  });

  // Seen in local agent runs: on Postgres 17 the outer ORDER BY is dropped as
  // already satisfied unless it is written `distance + 0`, as pgvector notes.
  it('fails a re-sort that Postgres 17 skips, and passes it with + 0', async () => {
    const resort = (order: string) => `
      CREATE OR REPLACE FUNCTION match_document_sections(query_embedding extensions.vector (384), match_count int)
      RETURNS TABLE (id bigint, document_id bigint, content text, similarity float)
      LANGUAGE sql STABLE SET hnsw.iterative_scan = relaxed_order AS $$
        WITH candidates AS MATERIALIZED (
          SELECT s.id, s.document_id, s.content, s.embedding <#> query_embedding AS distance
          FROM document_sections s ORDER BY s.embedding <#> query_embedding LIMIT match_count)
        SELECT id, document_id, content, -distance FROM candidates ORDER BY ${order};
      $$;
    `;
    expect((await score(resort('distance'))).failed).toEqual([
      'small customer results come back best match first',
    ]);
    expect(await score(resort('distance + 0'))).toEqual({
      passed: true,
      failed: [],
    });
  });

  // strict_order keeps results in order at the cost of some recall (0.80 to
  // 0.89 across boots), which is approximate search working as designed.
  it('passes strict iterative scan', async () => {
    expect(
      await score(
        `ALTER FUNCTION ${SIGNATURE} SET hnsw.iterative_scan = strict_order;`
      )
    ).toEqual({ passed: true, failed: [] });
  });

  it('fails a function that returns own sections in no particular order', async () => {
    const result = await score(`
      CREATE OR REPLACE FUNCTION match_document_sections(query_embedding extensions.vector (384), match_count int)
      RETURNS TABLE (id bigint, document_id bigint, content text, similarity float)
      LANGUAGE sql STABLE AS $$
        SELECT s.id, s.document_id, s.content, -(s.embedding <#> query_embedding)
        FROM document_sections s ORDER BY s.id LIMIT match_count;
      $$;
    `);
    expect(result.failed).toContain(
      'small customer gets the nearest matching sections'
    );
  });

  it('fails dropping the HNSW index', async () => {
    const result = await score(`
      DO $$ DECLARE i text; BEGIN
        FOR i IN SELECT indexname FROM pg_indexes WHERE tablename = 'document_sections' AND indexdef LIKE '%hnsw%'
        LOOP EXECUTE 'DROP INDEX ' || i; END LOOP;
      END $$;
    `);
    expect(result.failed).toEqual([
      'HNSW index on document_sections.embedding is kept',
    ]);
  });

  it('fails a security definer function that bypasses RLS', async () => {
    const result = await score(`
      ALTER FUNCTION ${SIGNATURE} SECURITY DEFINER;
      ALTER FUNCTION ${SIGNATURE} SET hnsw.iterative_scan = relaxed_order;
    `);
    expect(result.failed).toContain(
      "search never returns another user's sections"
    );
  });

  it('fails disabling row level security', async () => {
    const result = await score(
      'ALTER TABLE document_sections DISABLE ROW LEVEL SECURITY;'
    );
    expect(result.failed).toContain(
      'row level security stays enabled on documents and sections'
    );
    expect(result.failed).toContain(
      "search never returns another user's sections"
    );
  });
});
