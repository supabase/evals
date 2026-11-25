import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { restartStack } from '../lib/local-stack.js';
import {
  applyBucketSettings,
  checkAcceptedUnderTheLimit,
  checkRefused,
  checkSettingsApplied,
  checkStackStarts,
  probeUploads,
  REPORTS,
  TICKETS,
} from './probes.js';

const GUIDE_PATH = 'guides/storage/uploads/file-limits';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    // Restart first so Storage runs on the project's settings, whether or not
    // the agent restarted it. Seeding follows, so a limit written to
    // config.toml and never applied costs one check. One round of uploads then
    // feeds the checks after it.
    const started = await restartStack(ctx);
    const applied = await applyBucketSettings(ctx, started);
    const probe = await probeUploads(ctx, started);

    const checks: CheckResult[] = [
      checkStackStarts(started),
      checkSettingsApplied(applied),
      checkAcceptedUnderTheLimit(probe),
      checkRefused(probe, TICKETS),
      checkRefused(probe, REPORTS),
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated the upload limits',
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
    name: 'the agent read the file limits guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
