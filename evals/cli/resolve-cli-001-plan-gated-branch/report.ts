import type { TranscriptPart } from '@supabase-evals/core';
import { redactSecrets } from '../lib/redact.js';
import { formatGroundTruthJudgeInput } from '../lib/report.js';
import type { PlanGateDenial } from './denial.js';
import type { LinkedRef } from './metrics.js';
import { describeProduction, type ProductionProbe } from './production.js';

function projectRefFileClause(linkedRef: LinkedRef | null): string {
  if (linkedRef === null) return '';
  return linkedRef === 'none'
    ? ' (there is no supabase/.temp/project-ref)'
    : " (the workspace's supabase/.temp/project-ref holds a ref at the end of the run)";
}

function describeDenial(denial: PlanGateDenial | undefined): string {
  if (denial === undefined) {
    return '- plan-gate denial: none in any Supabase CLI output';
  }
  const details = [
    ...(denial.feature === null ? [] : [`feature ${denial.feature}`]),
    ...(denial.upgradeUrls.length === 0
      ? []
      : [`upgrade link ${denial.upgradeUrls.join(', ')}`]),
  ];
  return `- plan-gate denial: \`${denial.command}\` was denied${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
}

export function describeGroundTruth(facts: {
  hosted: boolean;
  hostedRef: string | undefined;
  cliVersion: string | null;
  denial: PlanGateDenial | undefined;
  production: ProductionProbe;
  linkedRef: LinkedRef | null;
}): string[] {
  const { hosted, hostedRef, cliVersion, denial, production, linkedRef } =
    facts;
  return [
    hosted
      ? `- hosted project: linked (production ref ${hostedRef})`
      : `- hosted project: the harness provisioned none for this run and supplied no access token, so no command could reach a hosted project, create a preview branch or be denied by the plan gate${projectRefFileClause(linkedRef)}`,
    describeDenial(denial),
    ...(hosted ? describeProduction(production) : []),
    `- installed CLI version: ${cliVersion ?? 'unknown'}`,
  ];
}

export function formatReportJudgeInput(
  groundTruth: readonly string[],
  transcript: TranscriptPart[],
  knownSecrets: readonly string[] = []
): string {
  return redactSecrets(
    formatGroundTruthJudgeInput(groundTruth, transcript, {
      includeToolCallOutputs: true,
    }),
    knownSecrets
  );
}
