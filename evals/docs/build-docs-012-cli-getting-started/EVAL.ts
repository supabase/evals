import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';

import {
  checkCliIsInstalled,
  checkCliIsPinnedInTheProject,
  checkCliRunsFromTheProject,
  checkProjectIsInitialized,
  readManifest,
} from './setup.js';

const GUIDE_PATH = 'local-development/cli/getting-started';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const initialized = await ctx.fileExists('supabase/config.toml');
    const manifest = await readManifest(ctx);

    const checks: CheckResult[] = [
      checkProjectIsInitialized(initialized),
      checkCliIsPinnedInTheProject(manifest),
      await checkCliIsInstalled(ctx),
      await checkCliRunsFromTheProject(ctx),
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated the local Supabase setup',
          passed: false,
          notes: message,
        },
      ],
    };
  }
};

export default scorer;

function checkGuideWasRead(ctx: LocalStackEvalContext): CheckResult {
  const calls = buildDocsResult(ctx.toolCalls).calls.filter((call) =>
    call.pages?.some((page) => page.url.includes(GUIDE_PATH))
  );
  const withContent = calls.filter((call) => call.hasContent);
  return {
    name: 'the agent read the Supabase CLI guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
