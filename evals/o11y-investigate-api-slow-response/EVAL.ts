import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: slow-api edge function has a 4s artificial delay.
// Evidence: seeded logs.jsonl showing high execution times.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const identifiedLatency =
    /slow.?api|4.?s|4000.?ms|execution.{0,20}time|latency|delay/i.test(report);
  const identifiedCause =
    /settimeout|artificial.{0,20}delay|blocking.{0,20}sleep|await.{0,20}promise/i.test(report);

  const checks: CheckResult[] = [
    { name: 'identified the slow-api function latency', passed: identifiedLatency },
    { name: 'identified the artificial delay as cause', passed: identifiedCause },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent reviewed the edge function logs, identified that
      slow-api consistently takes 4+ seconds (due to an artificial setTimeout
      delay), and proposed removing the delay from the function code.

      Fail if the agent misidentified the cause, blamed the wrong function, or
      gave only generic performance advice without identifying the specific delay.
    `,
  });
  checks.push({
    name: 'correctly diagnosed slow edge function and proposed fix',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
