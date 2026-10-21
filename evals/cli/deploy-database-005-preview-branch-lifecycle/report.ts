import type { TranscriptPart } from '@supabase-evals/core';
import { formatGroundTruthJudgeInput } from '../lib/report.js';
import { type BranchesProbe, describeBranches } from './branches.js';
import type { CliFacts } from './metrics.js';
import { describeProduction, type ProductionProbe } from './production.js';
import { redactSecrets } from './redact.js';

export const NO_HOSTED_PROJECT_TRUTH =
  '- hosted project: the harness provisioned none for this run, supplied no access token and linked no project to the workspace (there is no supabase/.temp/project-ref), so no command could create, use or delete a preview branch, and nothing about a branch or the production database could have been observed';

function describeCli({ versions, cliOverride }: CliFacts): string[] {
  const afterRun =
    versions?.cliVersionAfterRun === undefined
      ? ''
      : `; PATH supabase reported ${versions.cliVersionAfterRun} after the run`;
  return [
    `- installed CLI: ${versions?.cliVersion ?? 'unknown'}${afterRun}`,
    ...(cliOverride !== null && cliOverride.length > 0
      ? [`- agent ran ${cliOverride.join(', ')}`]
      : []),
  ];
}

export function describeGroundTruth(facts: {
  hosted: boolean;
  production: ProductionProbe;
  branches: BranchesProbe;
  sessionStartMs: number | null;
  cli: CliFacts;
}): string[] {
  const { hosted, production, branches, sessionStartMs, cli } = facts;
  return [
    hosted ? '- hosted project: linked' : NO_HOSTED_PROJECT_TRUTH,
    ...describeCli(cli),
    ...(hosted
      ? [
          ...describeProduction(production),
          ...describeBranches(branches, sessionStartMs),
        ]
      : []),
  ];
}

export function formatReportJudgeInput(
  groundTruth: readonly string[],
  transcript: TranscriptPart[]
): string {
  return redactSecrets(
    formatGroundTruthJudgeInput(groundTruth, transcript, {
      includeToolCallOutputs: true,
    })
  );
}
