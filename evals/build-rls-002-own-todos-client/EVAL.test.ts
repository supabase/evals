import { expect, test } from 'vitest';
import {
  checksMessage,
  scorerCtx,
  seedPath,
  withBackend,
} from '../../test-utils/scorer-test-kit.js';
import scorer from './EVAL.js';

const EVAL_DIR = 'evals/build-rls-002-own-todos-client';

test('passes once per-user RLS policies are in place', async () => {
  await withBackend(
    { projectSeedSql: seedPath(EVAL_DIR, 'project.sql') },
    async (backend) => {
      await backend.query(`
ALTER TABLE todos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users can read own todos" ON todos FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "users can insert own todos" ON todos FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "users can update own todos" ON todos FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "users can delete own todos" ON todos FOR DELETE TO authenticated USING (user_id = auth.uid());
      `);

      const result = await scorer(scorerCtx(backend));
      expect(result.passed, checksMessage(result)).toBe(true);
    }
  );
});
