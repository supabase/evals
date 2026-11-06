import { describe, expect, it } from 'vitest';
import {
  failedChecks,
  sparkScorer,
} from '../../../experiments/spark/lib/runtime-stub.js';
import scorer from './EVAL.js';

const embeddings = [
  '[0.9,0.1,0,0]',
  '[0,1,0,0]',
  '[1,0,0,0]',
  '[0.6,0,0.8,0]',
  '[0.71,0.71,0,0]',
  '[0.3,0,0,0.954]',
];

const good = {
  tables: {
    documents: [{ id: 1 }, { id: 2 }, { id: 3 }],
    document_sections: embeddings.map((embedding_json, index) => ({
      id: index + 1,
      content: `section ${index + 1}`,
      embedding_json,
    })),
  } as Record<string, unknown[]>,
  // What `typeof(embedding)` and `vector_extract(embedding)` return.
  vectors: embeddings.map((expected, index) => ({
    id: index + 1,
    kind: 'blob',
    vector: expected,
    expected,
  })),
  search: { 'user-a': [1, 5, 6], 'user-b': [3, 4] } as Record<string, number[]>,
};

async function score(reply: string, overrides: Partial<typeof good> = {}) {
  const world = { ...good, ...overrides };
  return failedChecks(
    await sparkScorer(
      scorer,
      async (url, init) => {
        if (url.pathname === '/database/query') {
          const { query } = JSON.parse(String(init?.body)) as { query: string };
          if (query.includes('vector_extract'))
            return Response.json(world.vectors);
          const owner = /owner_id = '([^']+)'/.exec(query)?.[1] ?? '';
          return Response.json(
            (world.search[owner] ?? []).map((id) => ({ id }))
          );
        }
        return Response.json(
          world.tables[url.pathname.replace('/rest/v1/', '')]
        );
      },
      { agentReport: reply }
    )
  );
}

const nearest = "Alice's 3 nearest sections are returned, most similar first";
const others = "Other users' sections are not returned";
const stored = 'Section embeddings are stored as vectors in `embedding`';
const searchA =
  "Searching user-a's sections with the `embedding` column returns their nearest first";
const searchB =
  "Searching user-b's sections with the `embedding` column returns their nearest first";

describe('vector search scorer', () => {
  it('accepts the right sections, fenced or bare', async () => {
    expect(await score('```json\n[1, 5, 6]\n```')).toEqual([]);
    expect(await score('[1,5,6]')).toEqual([]);
  });

  it('rejects a wrong order or wrong sections in the reply', async () => {
    expect(await score('[5,1,6]')).toEqual([nearest]);
    expect(await score('[1,5,2]')).toEqual([nearest]);
    expect(await score('[1,5]')).toEqual([nearest]);
  });

  it("rejects another user's section in the reply", async () => {
    expect(await score('[3,1,5]')).toEqual([nearest, others]);
  });

  it('rejects a reply without an id array', async () => {
    expect(await score('Sections one, five and six.')).toEqual([
      'Reply contains the section ids as a JSON array',
      nearest,
      others,
    ]);
  });

  it('detects changed seed data', async () => {
    expect(
      await score('[1,5,6]', {
        tables: { ...good.tables, document_sections: [{ id: 1 }] },
      })
    ).toEqual(['Seed data left unchanged']);
  });

  it('rejects embeddings that are not real vectors or do not match the json', async () => {
    expect(
      await score('[1,5,6]', {
        vectors: good.vectors.map((row) =>
          row.id === 1 ? { ...row, kind: 'text' } : row
        ),
      })
    ).toEqual([stored]);
    expect(
      await score('[1,5,6]', {
        vectors: good.vectors.map((row) =>
          row.id === 2 ? { ...row, vector: '[0,0.5,0,0]' } : row
        ),
      })
    ).toEqual([stored]);
  });

  it('accepts float formatting differences in the stored vectors', async () => {
    expect(
      await score('[1,5,6]', {
        vectors: good.vectors.map((row) =>
          row.id === 1
            ? { ...row, vector: '[0.9000000059604645,0.1,0,0]' }
            : row
        ),
      })
    ).toEqual([]);
  });

  it("detects a column whose search returns the wrong users' sections", async () => {
    expect(
      await score('[1,5,6]', {
        search: { 'user-a': [1, 5, 6], 'user-b': [4, 3] },
      })
    ).toEqual([searchB]);
    expect(
      await score('[1,5,6]', {
        search: { 'user-a': [5, 1, 6], 'user-b': [3, 4] },
      })
    ).toEqual([searchA]);
  });
});
