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
  checkBanner,
  checkDeleted,
  checkInserted,
  checkOthers,
  checkPrevious,
  checkUpdated,
  checkVisitor,
  type Observation,
  observe,
  type Run,
} from './probes.js';

const GUIDE_PATH = 'guides/realtime/postgres-changes';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const migrations = await applyPendingMigrations(ctx);
    const run: Run = (sql) => execSql(ctx, sql, { tuplesOnly: true });
    const observed = await observe(ctx, run);
    const probe = (
      name: string,
      check: (observation: Observation) => CheckResult
    ): CheckResult =>
      'observation' in observed
        ? check(observed.observation)
        : { name, passed: false, notes: `not run: ${observed.failure}` };

    const checks: CheckResult[] = [
      checkMigrationsWereApplied(migrations),
      probe(CHECK.inserted, (observation) => checkInserted(observation)),
      probe(CHECK.updated, (observation) => checkUpdated(observation)),
      probe(CHECK.previous, (observation) => checkPrevious(observation)),
      probe(CHECK.deleted, (observation) => checkDeleted(observation)),
      probe(CHECK.others, (observation) => checkOthers(observation)),
      probe(CHECK.visitor, (observation) => checkVisitor(observation)),
      probe(CHECK.banner, (observation) => checkBanner(observation)),
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated who gets order changes live',
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
    name: 'the agent read the Postgres Changes guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
