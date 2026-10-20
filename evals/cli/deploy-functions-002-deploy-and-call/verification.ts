import type { TranscriptPart } from '@supabase-evals/core';
import { formatGroundTruthJudgeInput } from '../lib/report.js';
import { describeDeployment, type DeploymentProbe } from './hosted.js';
import { FUNCTION_SLUG } from './seed.js';

export function describeVerificationFacts(facts: {
  ref: string;
  deployment: DeploymentProbe;
}): string[] {
  return [
    `- hosted project ref: ${facts.ref}`,
    `- the deployed function's path on the project's host is /functions/v1/${FUNCTION_SLUG}`,
    ...describeDeployment(facts.deployment),
  ];
}

/** Facts plus the full transcript with tool outputs, so the judge sees what each request came back with. */
export function formatVerificationJudgeInput(
  facts: readonly string[],
  transcript: TranscriptPart[]
): string {
  return formatGroundTruthJudgeInput(facts, transcript, {
    includeToolCallOutputs: true,
  });
}
