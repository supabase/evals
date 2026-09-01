import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';

import { checkAccess } from './access.js';
import { checkBundle } from './bundle.js';
import { checkServer } from './server.js';

// SCRATCH (do not merge): the preview host, not just the path, so a fetch of
// the published page does not count as reading the page under test.
const GUIDE_PATH =
  'docs-git-docs-api-keys-content-supabase.vercel.app/docs/guides/getting-started/api-keys';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const status = await ctx.stackStatus();

    // Build and scan first. The probes sign users up, and nothing they write
    // should be in scope when the bundle is read.
    const bundle = await checkBundle(ctx, status);
    const server = checkServer(ctx);
    const access = await checkAccess(ctx, status);

    const checks: CheckResult[] = [
      bundle.viteBuild,
      bundle.clientKey,
      bundle.newKeyFormat,
      bundle.noSecretInBundle,
      bundle.noSecretInSource,
      bundle.signUpWired,
      bundle.noExposedEnvVar,
      server.noLegacyKeyVar,
      access.roster,
      access.emailsHidden,
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
          name: 'scorer evaluated API key placement',
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
    name: 'the agent read the API keys guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
