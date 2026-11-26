import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import {
  applyPendingMigrations,
  checkMigrationsWereApplied,
} from './migrations.js';
import {
  addMarked,
  checkCount,
  checkExisting,
  checkOrder,
  checkStored,
  search,
  searchSeeded,
} from './probes.js';

const GUIDE_PATH = 'guides/database/extensions/pgvector';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    // An unapplied migration should cost one check, not all of them.
    const migrations = await applyPendingMigrations(ctx);
    const client = await ctx.getClient();

    // The seeded articles are searched before the scorer adds any row of its
    // own, so nothing of the scorer's can stand between an article and its
    // own text. The added articles carry a marker and a vector that no seeded
    // article is near, and both searches run once so every check reads the
    // same answers.
    const existing = await searchSeeded(ctx, client);
    const marked = await addMarked(ctx);
    const closest = marked.ok
      ? await search(client, marked.query, 20)
      : undefined;
    const limited = marked.ok
      ? await search(client, marked.query, 2, closest?.ok ? 8 : 1)
      : undefined;

    const checks: CheckResult[] = [
      checkMigrationsWereApplied(migrations),
      await checkStored(marked, closest),
      checkOrder(marked, closest),
      checkCount(marked, limited),
      checkExisting(existing),
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated whether articles are stored and searched by similarity',
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
    name: 'the agent read the pgvector guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
