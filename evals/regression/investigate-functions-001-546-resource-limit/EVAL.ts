import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

const scorer: ToolScorer = async (ctx) => {
  const input = serializeTranscript(ctx.transcript);

  const [signalFound, causeAttributed, remedyGiven] = await Promise.all([
    judge({
      input,
      rubric: stripIndent`
        Pass if the assistant identified video-thumbnails as the affected function and recognized that its errors are HTTP 546 responses (a resource limit / WORKER_LIMIT / WORKER_RESOURCE_LIMIT), not 500s or 503s.

        Fail if the assistant missed video-thumbnails entirely, flagged the unrelated welcome-email 500 as the main issue, misidentified the status code as a plain server error or a boot/timeout failure, or gave only a vague description of errors without naming the function and the 546 status.
      `,
    }),
    judge({
      input,
      rubric: stripIndent`
        Pass if the assistant attributed the 546s specifically to CPU time exhaustion (the logged shutdown reason is CPUTime), grounding this in the log evidence (the shutdown/reason entries, or the cpu_time_used value at the isolate's CPU ceiling).

        Fail if the assistant blames memory or wall-clock time instead of CPU time, attributes the failures to a code bug/exception, attributes them to the unrelated welcome-email error, or gives no specific resource attribution at all.
      `,
    }),
    judge({
      input,
      rubric: stripIndent`
        Pass if the assistant recommended reducing or offloading the function's CPU-intensive work as the fix, such as optimizing the thumbnail-generation code, processing smaller chunks, moving the heavy work to a background job or an external service, or splitting the function so no single invocation does as much CPU work.

        Fail if the assistant recommends only retrying, increasing a timeout, upgrading the project/plan to raise the resource ceiling, or otherwise proposes something that does not reduce the function's CPU usage — Edge Function CPU/memory isolate limits are fixed and cannot be raised.
      `,
    }),
  ]);

  const checks: CheckResult[] = [
    {
      name: 'identified video-thumbnails and the 546 resource-limit pattern',
      passed: signalFound.passed,
      judgeNotes: signalFound.notes,
    },
    {
      name: 'attributed the 546s to CPU time exhaustion',
      passed: causeAttributed.passed,
      judgeNotes: causeAttributed.notes,
    },
    {
      name: 'recommended reducing/offloading CPU work as the fix',
      passed: remedyGiven.passed,
      judgeNotes: remedyGiven.notes,
    },
  ];

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
};

export default scorer;
