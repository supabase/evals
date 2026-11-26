import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';

import {
  CHECK,
  checkFunctionAnswers,
  checkGreetsByName,
  checkSaysItIsJson,
  checkStackIsRunning,
  probeWelcome,
} from './probes.js';
import { readStackState } from './stack.js';

// Not a bare prefix: the guide links to `quickstart-dashboard`, which is a
// different page.
const GUIDE_PATH = /guides\/functions\/quickstart(?:\.md)?(?:[?#]|$)/;

const scorer: LocalStackScorer = async (ctx) => {
  try {
    // The stack first: every probe is a request to it, and an agent that left
    // it down costs one check rather than the whole result.
    const stack = await readStackState(ctx);
    const probe = stack.running ? await probeWelcome(stack) : undefined;

    const checks: CheckResult[] = [
      checkStackIsRunning(stack),
      checkFunctionAnswers(probe),
      checkGreetsByName(probe),
      checkSaysItIsJson(probe),
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated what the welcome function answers with',
          passed: false,
          notes: message,
        },
      ],
    };
  }
};

export default scorer;

// A search_docs hit carries the guide's url in its result, not its request, so
// reuse the harness's own resolution rather than scanning the raw tool call.
function checkGuideWasRead(ctx: LocalStackEvalContext): CheckResult {
  const calls = buildDocsResult(ctx.toolCalls).calls.filter((call) =>
    call.pages?.some((page) => GUIDE_PATH.test(page.url))
  );
  const withContent = calls.filter((call) => call.hasContent);
  return {
    name: CHECK.guide,
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
