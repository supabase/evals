import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: random_page_cost = 4.0 (spinning-disk default). On SSD-backed Supabase,
// it should be 1.1 so the planner prefers index scans appropriately.
// Fix: ALTER SYSTEM SET random_page_cost = 1.1 (or ALTER ROLE / ALTER DATABASE).
// NOTE: pg_settings is available in PGlite and shows the default of 4.0 —
// no fake table needed.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const identifiedHighCost =
    /random_page_cost.{0,30}(4\.0|4|too.{0,10}high|spinning|hdd|disk)/i.test(report);
  const proposedCorrectValue =
    /1\.1|random_page_cost.{0,30}(lower|reduce|ssd)/i.test(report);
  const proposedFix =
    /alter.{0,10}(system|role|database).{0,30}random_page_cost/i.test(report);

  const checks: CheckResult[] = [
    { name: 'identified random_page_cost is set to the HDD default (4.0)', passed: identifiedHighCost },
    { name: 'proposed lowering it to ~1.1 for SSD', passed: proposedCorrectValue },
    { name: 'included a concrete ALTER SQL command', passed: proposedFix },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent:
      1. Identified that random_page_cost is 4.0 (the default calibrated for
         spinning HDDs) and explained that Supabase runs on SSDs where random
         I/O is much cheaper.
      2. Proposed setting it to approximately 1.1 via ALTER SYSTEM SET
         random_page_cost = 1.1 or ALTER DATABASE / ALTER ROLE equivalent.

      Fail if the agent did not cite the current value, did not explain the SSD
      vs HDD distinction, or gave no SQL command with the corrected value.
    `,
  });
  checks.push({
    name: 'correctly diagnosed high random_page_cost and proposed fix',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
