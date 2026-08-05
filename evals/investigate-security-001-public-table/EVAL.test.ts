import { judge } from '@supabase-evals/core';
import type * as Core from '@supabase-evals/core';
import { expect, test, vi } from 'vitest';
import {
  checksMessage,
  failedCheckNames,
  scorerCtx,
  seedPath,
  withBackend,
} from '../../test-utils/scorer-test-kit.js';
import type { TranscriptPart } from '@supabase-evals/core';
import scorer from './EVAL.js';

// The scorer's fourth check calls a real OpenAI judge, which needs
// OPENAI_API_KEY and bills per run. Stub only `judge` so this suite stays
// hermetic in CI; every other core export the scorer uses stays real, so the
// deterministic checks are still exercised for real.
vi.mock('@supabase-evals/core', async (importOriginal) => ({
  ...(await importOriginal<typeof Core>()),
  judge: vi.fn(async () => ({ passed: true, notes: 'stubbed verdict' })),
}));

const GOOD_REPORT = [
  'customer_payment_methods is exposed to anon.',
  'Fix by REVOKE SELECT ON customer_payment_methods FROM anon and enable row level security.',
].join(' ');

const VAGUE_REPORT =
  'Some tables look insecure, you should tighten permissions.';

// The judge reads the transcript, so surface the report as assistant text.
const asTranscript = (report: string): TranscriptPart[] => [
  { type: 'message', role: 'assistant', content: report },
];

test('scores a report that names the exposure and the fix', async () => {
  await withBackend(
    {
      projectSeedSql: seedPath(import.meta.url, 'project.sql'),
      logsSeedJsonl: seedPath(import.meta.url, 'logs.jsonl'),
    },
    async (backend) => {
      const { rows } = await backend.query(`
SELECT grantee FROM information_schema.role_table_grants
WHERE table_name = 'customer_payment_methods' AND privilege_type = 'SELECT'
ORDER BY grantee;
      `);
      expect(
        (rows as Array<{ grantee: string }>).some(
          (row) => row.grantee === 'anon'
        ),
        'seed should expose customer_payment_methods to anon'
      ).toBe(true);

      const passing = await scorer(
        scorerCtx(backend, {
          agentReport: GOOD_REPORT,
          transcript: asTranscript(GOOD_REPORT),
        })
      );
      expect(passing.passed, checksMessage(passing)).toBe(true);

      // The judge scores the transcript, not the report field.
      expect(vi.mocked(judge).mock.calls[0]?.[0].input).toContain(
        'customer_payment_methods'
      );

      const vague = await scorer(
        scorerCtx(backend, {
          agentReport: VAGUE_REPORT,
          transcript: asTranscript(VAGUE_REPORT),
        })
      );
      expect(vague.passed).toBe(false);
      expect(failedCheckNames(vague)).toEqual([
        'named the vulnerable table',
        'mentioned the anon role',
        'proposed a concrete fix',
      ]);
    }
  );
});
