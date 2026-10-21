import type { TranscriptPart } from '@supabase-evals/core';
import { formatGroundTruthJudgeInput } from '../lib/report.js';
import { type BranchesProbe, describeBranches } from './branches.js';
import { describeProduction, type ProductionProbe } from './production.js';
import { redactSecrets } from './redact.js';
import {
  BASELINE_TABLE,
  BASELINE_VERSION,
  NEW_MIGRATION_FILE,
  NEW_MIGRATION_VERSION,
  NEW_TABLE,
} from './seed.js';

export function describeLifecycleFacts(facts: {
  ref: string;
  production: ProductionProbe;
  branches: BranchesProbe;
  sessionStartMs: number | null;
  refs: readonly string[];
}): string[] {
  return [
    `- production project ref: ${facts.ref}`,
    `- the new migration: supabase/migrations/${NEW_MIGRATION_FILE} (version ${NEW_MIGRATION_VERSION}), which creates public.${NEW_TABLE}`,
    `- the migration already on production: ${BASELINE_VERSION} (creates public.${BASELINE_TABLE})`,
    ...describeProduction(facts.production),
    ...describeBranches(facts.branches, facts.sessionStartMs, facts.refs),
  ];
}

export function formatLifecycleJudgeInput(
  facts: readonly string[],
  transcript: TranscriptPart[]
): string {
  return redactSecrets(
    formatGroundTruthJudgeInput(facts, transcript, {
      includeToolCallOutputs: true,
    })
  );
}
