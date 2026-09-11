import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';

import { runProbes } from './probes.js';
import { loadSources, sourceChecks } from './source.js';

const GUIDE_PATH = 'guides/auth/server-side/creating-a-client';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    // Read the workspace as the agent left it, before the probes install
    // dependencies and build.
    const sources = sourceChecks(loadSources(ctx.hostWorkspace));
    const probes = await runProbes(ctx);

    const checks: CheckResult[] = [
      ...probes,
      ...sources,
      checkGuideWasRead(ctx),
    ];

    return {
      passed: checks.every((check) => check.passed),
      checks,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated the server-side auth client',
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
// `core/share-docs-guide-read-check` moves this into core as checkDocsGuideRead.
function checkGuideWasRead(ctx: LocalStackEvalContext): CheckResult {
  const calls = buildDocsResult(ctx.toolCalls).calls.filter((call) =>
    call.pages?.some((page) => page.url.includes(GUIDE_PATH))
  );
  const withContent = calls.filter((call) => call.hasContent);
  return {
    name: 'the agent read the server-side client guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
