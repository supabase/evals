import type { EvalBatch, EvalRunInput } from '../schemas.js';
import { runEvalWorkflow, type EvalResult } from './run-eval.js';

const DEFAULT_CONCURRENCY = 10;
const MAX_EVAL_ATTEMPTS = 3;

export interface SettledEval {
  experiment: string;
  evalId: string;
  result?: EvalResult;
  error?: string;
}

export interface EvalBatchResult {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  evals: SettledEval[];
}

export async function runEvalsWorkflow(
  batch: EvalBatch
): Promise<EvalBatchResult> {
  'use workflow';

  const items = batch.items.map((input) => ({
    ...input,
    ref: input.ref ?? batch.ref,
  }));
  const concurrency = Math.max(1, batch.concurrency ?? DEFAULT_CONCURRENCY);
  const settled: SettledEval[] = [];

  // Workers take the next eval as soon as their own finishes.
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        settled[index] = await runOne(items[index]);
      }
    })
  );

  return {
    total: settled.length,
    passed: settled.filter((entry) => entry.result?.passed).length,
    failed: settled.filter((entry) => entry.result?.passed === false).length,
    errored: settled.filter((entry) => entry.error !== undefined).length,
    evals: settled,
  };
}

/**
 * Retries an eval in a fresh Sandbox, since a failed one can leave ports
 * occupied, then reports a final failure as a value so one bad eval can't sink
 * the batch.
 */
async function runOne(input: EvalRunInput): Promise<SettledEval> {
  const { experiment, evalId } = input;

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_EVAL_ATTEMPTS; attempt += 1) {
    try {
      return { experiment, evalId, result: await runEvalWorkflow(input) };
    } catch (error) {
      lastError = error;
      console.error(
        `Attempt ${attempt}/${MAX_EVAL_ATTEMPTS} failed for ${experiment} x ${evalId}`,
        error
      );
    }
  }

  return {
    experiment,
    evalId,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  };
}
