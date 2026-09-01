import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: 'report' edge function has a 4s blocking delay (setTimeout).
// Evidence: seeded logs.jsonl showing consistently high execution times.

const scorer: ToolScorer = async (ctx) => {
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });
  const report = ctx.agentReport ?? '';

  const identifiedFunction =
    /\breport\b.{0,30}(slow|latency|delay|4s|4000)/i.test(report) ||
    /(slow|latency|delay|4s|4000).{0,30}\breport\b/i.test(report);

  const checks: CheckResult[] = [
    { name: 'identified the report function as slow', passed: identifiedFunction },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent identified the 'report' edge function as consistently
      slow (4+ seconds per invocation based on logs) and proposed removing the
      blocking delay (setTimeout or similar) from the function code.

      Fail if the agent blamed the wrong function, gave only generic advice, or
      did not propose a specific code fix.
    `,
  });
  checks.push({
    name: 'correctly diagnosed slow edge function',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
