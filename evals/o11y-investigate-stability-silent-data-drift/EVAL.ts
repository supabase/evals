import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: a BEFORE INSERT trigger on orders silently zeroes total_cents.
// No error is ever raised — pure data corruption. This is an investigate eval
// scored on whether the agent finds and explains the trigger.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const identifiedTrigger =
    /trigger|_corrupt|trg_corrupt/i.test(report);
  const identifiedZeroing =
    /zero|total_cents\s*:?=\s*0|zeroed|zero.{0,20}total/i.test(report);

  const checks: CheckResult[] = [
    { name: 'identified a trigger as the cause', passed: identifiedTrigger },
    { name: 'identified total_cents being zeroed', passed: identifiedZeroing },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent discovers that a BEFORE INSERT trigger on public.orders
      (trg_corrupt or similar) is silently setting total_cents to 0 on every
      insert, and proposes dropping or fixing the trigger.

      Fail if the agent blames an application bug, a default value, or does not
      identify the trigger as the root cause.
    `,
  });
  checks.push({
    name: 'correctly identified corrupting trigger',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
