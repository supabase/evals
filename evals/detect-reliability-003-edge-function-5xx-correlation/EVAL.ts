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
        Pass if the assistant identified image-transform as the affected function and located the burst of 12 HTTP 503 responses in the 2026-04-28T10:18Z–2026-04-28T10:29Z window (or an equivalent specific window covering those events).

        Fail if the assistant missed image-transform entirely, flagged only the old billing-webhook 503s from 2026-04-26 as the main issue, or gave only a vague description of errors without naming the function and window.
      `,
    }),
    judge({
      input,
      rubric: stripIndent`
        Pass if the assistant made clear that Edge Function invocation rows are absent or missing for the failing window while nearby successful invocations exist, and drew the correct conclusion: the evidence points to a gateway/platform failure before the invocation record was created, not an application exception visible through the MCP's invocation log surface.

        Fail if the assistant claimed the image-transform function code itself threw the errors (based on function runtime logs), ignored the absence of invocation rows, or treated the gateway 503s as equivalent to function-level errors.
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
      name: "identified image-transform and the 503 burst window",
      passed: signalFound.passed,
      judgeNotes: signalFound.notes,
    },
    {
      name: "correlated absent invocation rows to a gateway/platform failure",
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
