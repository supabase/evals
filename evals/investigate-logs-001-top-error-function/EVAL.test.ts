import { expect, test } from 'vitest';
import {
  checksMessage,
  scorerCtx,
  seedPath,
  withBackend,
} from '../../test-utils/scorer-test-kit.js';
import scorer from './EVAL.js';

const EVAL_DIR = 'evals/investigate-logs-001-top-error-function';

test('passes for a report naming the top error function and its count', async () => {
  await withBackend(
    { logsSeedJsonl: seedPath(EVAL_DIR, 'logs.jsonl') },
    async (backend) => {
      const result = await scorer(
        scorerCtx(backend, {
          agentReport:
            'stripe-webhook had the most errors with 9 errors out of 50 events.',
        })
      );

      expect(result.passed, checksMessage(result)).toBe(true);
    }
  );
});
