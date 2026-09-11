import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';

import { checkClient } from './client.js';
import { checkProbes } from './probes.js';
import { checkSecret } from './secret.js';

const GUIDE_PATH = 'guides/functions/secrets';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    // Scoped to the run, so nothing a previous run left behind can satisfy a
    // probe in this one.
    const marker = `eval-${Date.now().toString(36)}`;

    // Static first. The client build writes dist/, and the probe wakes a
    // function that may write files of its own, so neither should be in scope
    // when the workspace is read for the key.
    const secret = await checkSecret(ctx);
    const client = await checkClient(ctx);
    const probes = await checkProbes(ctx, marker);

    const checks: CheckResult[] = [
      client.build,
      client.notInBundle,
      client.noExposedEnvVar,
      client.notInSource,
      secret.readsFromEnv,
      secret.loadablePath,
      secret.ignored,
      probes.served,
      probes.keyAtRuntime,
      probes.noEcho,
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated provider key placement',
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
    call.pages?.some((page) => page.url.includes(GUIDE_PATH))
  );
  const withContent = calls.filter((call) => call.hasContent);
  return {
    name: 'the agent read the Managing secrets guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
