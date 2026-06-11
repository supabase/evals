import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolScorer,
} from "@supabase-evals/core";
import { stripIndent } from "common-tags";

const scorer: ToolScorer = async (ctx) => {
  const input = serializeTranscript(ctx.transcript);

  const [signalFound, correlationMade, nextStepGiven] = await Promise.all([
    judge({
      input,
      rubric: stripIndent`
        Pass if the assistant identified image-transform as the affected function and recognized the recurring pattern of HTTP 503 responses throughout the morning of 2026-04-28 (covering most or all of the 8 gateway failures spread across 07:00Z-12:00Z).

        Fail if the assistant missed image-transform entirely, flagged only the old billing-webhook 503s from 2026-04-26 as the main issue, or gave only a vague description of errors without naming the function and the recurring pattern.
      `,
    }),
    judge({
      input,
      rubric: stripIndent`
        The failing image-transform 503s originate at the gateway / Edge Functions platform layer (in front of the function), not from the function's own code.

        Pass if BOTH:
        1. The assistant attributes the recurring 503s to the gateway/platform layer rather than to the function's application code, AND
        2. The attribution is grounded in at least one valid observation from the data, such as: the 503s appear only on the gateway/HTTP log surface with no corresponding invocation/runtime rows for that window (while nearby invocations succeeded), the deployment_id/version is unchanged across the outage (ruling out a bad rollout), or that a gateway 503 is categorically distinct from a function-level error like avatar-upload's logged 500.

        Fail if the assistant: blames the image-transform function code or runtime as the primary cause, recommends fixing or redeploying the function as the remediation, treats the gateway 503s as equivalent to function-level errors, or gives no layer attribution at all.
      `,
    }),
    judge({
      input,
      rubric: stripIndent`
        Pass if the assistant recommended a concrete next step, such as escalating or opening an incident with the gateway request IDs and time window, checking Edge Function platform or runtime health, reviewing deployment or routing configuration, or investigating correlated infrastructure logs.

        Fail if the assistant gave only vague advice like "check the logs" or "monitor the situation" without a specific actionable step.
      `,
    }),
  ]);

  const checks: CheckResult[] = [
    {
      name: "identified image-transform and the recurring 503 pattern",
      passed: signalFound.passed,
      judgeNotes: signalFound.notes,
    },
    {
      name: "attributed recurring 503s to gateway/platform layer, not function code",
      passed: correlationMade.passed,
      judgeNotes: correlationMade.notes,
    },
    {
      name: "recommended a concrete next step",
      passed: nextStepGiven.passed,
      judgeNotes: nextStepGiven.notes,
    },
  ];

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
};

export default scorer;
