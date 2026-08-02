/**
 * Records every `judge()` call made while a scorer runs — rubric, input,
 * verdict, model, tokens — without any per-eval wiring: the eval runner
 * wraps the scorer invocation in `collectJudgeCalls`, and `judge()` appends
 * to whichever collection is active on the async context. The records are
 * persisted with the raw result so the Braintrust upload can show exactly
 * what each judge saw (its input is otherwise discarded after the call).
 *
 * AsyncLocalStorage keeps concurrent eval runs in one process from
 * interleaving their judge calls.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentUsage } from "./index.js";

export interface JudgeCallRecord {
  rubric: string;
  input: string;
  passed: boolean;
  notes?: string;
  modelId: string;
  durationMs: number;
  usage?: AgentUsage;
}

const storage = new AsyncLocalStorage<JudgeCallRecord[]>();

/** Append a judge call to the active collection, if any (no-op outside one). */
export function recordJudgeCall(record: JudgeCallRecord): void {
  storage.getStore()?.push(record);
}

/** Run `fn` (typically a scorer) and collect the judge calls it made. */
export async function collectJudgeCalls<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; judgeCalls: JudgeCallRecord[] }> {
  const judgeCalls: JudgeCallRecord[] = [];
  const result = await storage.run(judgeCalls, fn);
  return { result, judgeCalls };
}
