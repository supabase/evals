import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolScorer,
} from "@supabase-evals/core";
import { stripIndent } from "common-tags";

const scorer: ToolScorer = async (ctx) => {
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript),
    rubric: stripIndent`
      Pass if the assistant correctly investigates the customer's vague image processing failure report and explains the planted Edge Function 5xx issue.

      A passing answer should:
      - Identify image-transform as the affected function.
      - Say that gateway/invocation logs show a burst of 12 HTTP 503 responses in the 2026-04-28T10:18Z through 2026-04-28T10:29Z window, or an equivalent specific window covering those events.
      - Make clear that corresponding Edge Function invocation rows are absent or missing for that same failing window, while nearby successful invocations exist.
      - Draw the right conclusion: the evidence points to a gateway/platform/invocation-path failure before the normal Edge Function invocation record was created, not an application exception visible through the MCP's exposed invocation log surface.
      - Recommend a concrete next step, such as escalating/opening an incident with the gateway/request ids and time window, checking Edge Function platform/runtime health, deployment/routing, or correlated infrastructure logs.

      Fail if the assistant only says there are generic 5xxs, flags the old billing-webhook errors outside the customer report window as the main issue, claims the image-transform function code threw errors based on function runtime logs, misses the absence of matching invocation rows, or gives only vague advice like "check the logs" without a specific next step.
    `,
  });

  const checks: CheckResult[] = [
    {
      name: "diagnosed edge function 5xx correlation issue",
      passed: verdict.passed,
      judgeNotes: verdict.notes,
    },
  ];

  return {
    passed: verdict.passed,
    checks,
  };
};

export default scorer;
