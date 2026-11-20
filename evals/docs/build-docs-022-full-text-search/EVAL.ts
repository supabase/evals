import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { execSql } from '../lib/exec-sql.js';
import {
  applyPendingMigrations,
  checkMigrationsWereApplied,
} from './migrations.js';
import {
  CHECK,
  checkCallable,
  checkMatches,
  checkNoText,
  checkOrder,
  checkTyped,
  search,
  searchTerms,
  setupWorld,
} from './probes.js';

const GUIDE_PATH = 'guides/database/full-text-search';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    // An unapplied migration should cost one check, not all of them.
    const migrations = await applyPendingMigrations(ctx);
    const run = (sql: string) => execSql(ctx, sql, { tuplesOnly: true });

    // The articles go in after the agent is done, so nothing can be satisfied
    // by rows the agent wrote. Both searches run once and every check reads
    // the same answers.
    const setup = await setupWorld(run);
    let probes: CheckResult[];
    if ('failure' in setup) {
      probes = Object.values(CHECK).map((name) => ({
        name,
        passed: false,
        notes: `not run: ${setup.failure}`,
      }));
    } else {
      const { world } = setup;
      const terms = searchTerms(world);
      const single = await search(run, terms.single);
      const typed = await search(run, terms.typed);
      probes = [
        checkCallable(single),
        checkMatches(world, single),
        checkNoText(world, single),
        checkOrder(world, single),
        checkTyped(world, typed),
      ];
    }

    const checks: CheckResult[] = [
      checkMigrationsWereApplied(migrations),
      ...probes,
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated whether a search returns ranked matches',
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
    name: 'the agent read the full text search guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
