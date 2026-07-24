import { describe, it, expect } from 'vitest';
import { createTestApp, request } from './helpers.js';

const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

async function query<T = unknown>(
  app: Awaited<ReturnType<typeof createTestApp>>,
  ref: string,
  sql: string
) {
  return request<T>(app, 'POST', `/v1/projects/${ref}/database/query`, {
    query: sql,
  });
}

describe('storage schema', () => {
  it('provisions storage.buckets and storage.objects with RLS enabled and no policies', async () => {
    const app = await createTestApp([{ ref: 'storage-proj' }]);

    const { status, data } = await query<
      Array<{ relname: string; relrowsecurity: boolean; policies: number }>
    >(
      app,
      'storage-proj',
      `
        SELECT c.relname, c.relrowsecurity,
               (SELECT count(*)::int FROM pg_policies p
                WHERE p.schemaname = 'storage' AND p.tablename = c.relname) AS policies
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'storage' AND c.relkind = 'r'
        ORDER BY c.relname;
      `
    );

    expect(status).toBe(200);
    expect(data).toEqual([
      { relname: 'buckets', relrowsecurity: true, policies: 0 },
      { relname: 'objects', relrowsecurity: true, policies: 0 },
    ]);
  });

  it('supports storage.foldername for path-scoped policies', async () => {
    const app = await createTestApp([{ ref: 'foldername-proj' }]);

    const { status, data } = await query<Array<{ folder: string }>>(
      app,
      'foldername-proj',
      `SELECT (storage.foldername('${USER_A}/receipts/march.pdf'))[1] AS folder;`
    );

    expect(status).toBe(200);
    expect(data).toEqual([{ folder: USER_A }]);
  });

  it('lets owner-scoped policies govern object access for the API roles', async () => {
    const app = await createTestApp([{ ref: 'storage-rls-proj' }]);

    await query(
      app,
      'storage-rls-proj',
      `
      INSERT INTO storage.buckets (id, name, public) VALUES ('files', 'files', false);
      CREATE POLICY "users read own files" ON storage.objects FOR SELECT TO authenticated
        USING ((storage.foldername(name))[1] = auth.uid()::text);
      INSERT INTO storage.objects (bucket_id, name, owner, owner_id) VALUES
        ('files', '${USER_A}/a.pdf', '${USER_A}', '${USER_A}'),
        ('files', '${USER_B}/b.pdf', '${USER_B}', '${USER_B}');
    `
    );

    const asUser = (sub: string) => `
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${sub}';
      SET LOCAL request.jwt.claim.role = 'authenticated';
      SELECT name FROM storage.objects ORDER BY name;
      COMMIT;
    `;

    const seenByA = await query<Array<{ name: string }>>(
      app,
      'storage-rls-proj',
      asUser(USER_A)
    );
    expect(seenByA.status).toBe(200);
    expect(seenByA.data).toEqual([{ name: `${USER_A}/a.pdf` }]);

    const seenByB = await query<Array<{ name: string }>>(
      app,
      'storage-rls-proj',
      asUser(USER_B)
    );
    expect(seenByB.status).toBe(200);
    expect(seenByB.data).toEqual([{ name: `${USER_B}/b.pdf` }]);
  });
});
