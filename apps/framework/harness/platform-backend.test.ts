import { expect, test } from 'vitest';
import { bootPlatformBackend } from './platform-backend.js';
import { seedPath, withBackend } from '../../../test-utils/scorer-test-kit.js';

const LOGS_EVAL = 'evals/investigate-logs-001-top-error-function';

test('supalite auth issues a session supabase-js can write and read under RLS', async () => {
  await withBackend({}, async (backend) => {
    await backend.query(`
CREATE TABLE todos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  body text NOT NULL
);

ALTER TABLE todos ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON todos TO authenticated;

CREATE POLICY "users can insert their own todos" ON todos FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "users can read their own todos" ON todos FOR SELECT TO authenticated USING (user_id = auth.uid());
    `);

    const client = backend.client;
    const { data: signup, error: signupError } = await client.auth.signUp({
      email: `smoke-${Date.now()}@example.com`,
      password: 'secret123',
    });
    expect(signupError).toBeNull();
    expect(signup.user?.id).toBeTruthy();

    const { error: insertError } = await client.from('todos').insert({
      user_id: signup.user?.id,
      body: 'verify supabase-js path',
    });
    expect(insertError).toBeNull();

    const { data: rows, error: selectError } = await client
      .from('todos')
      .select('body')
      .eq('user_id', signup.user?.id);
    expect(selectError).toBeNull();
    expect(rows).toEqual([{ body: 'verify supabase-js path' }]);
  });
});

test('close disposes the platform, and is idempotent', async () => {
  const backend = await bootPlatformBackend({});
  await backend.query('select 1 as n');
  await backend.close();

  await expect(backend.query('select 1 as n')).rejects.toThrow();
  await expect(backend.close()).resolves.not.toThrow();
});

test('seeded logs are queryable over the analytics endpoint', async () => {
  await withBackend(
    { logsSeedJsonl: seedPath(LOGS_EVAL, 'logs.jsonl') },
    async ({ url, ref, accessToken }) => {
      const sql = 'SELECT count(*)::int AS n FROM edge_logs';
      const res = await fetch(
        `${url}/v1/projects/${ref}/analytics/endpoints/logs.all?sql=${encodeURIComponent(sql)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const body = (await res.json()) as { result: Array<{ n: number }> };

      expect(body.result[0]?.n).toBeGreaterThan(0);
    }
  );
});
