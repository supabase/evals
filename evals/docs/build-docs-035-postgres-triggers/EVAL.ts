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
  checkBackOfficeChange,
  checkBulkCancel,
  checkCustomerChange,
  checkCustomersCannotWrite,
  checkCustomersReadOwn,
  checkUnchangedStatus,
  type Run,
} from './probes.js';

const GUIDE_PATH = 'guides/database/postgres/triggers';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const migrations = await applyPendingMigrations(ctx);
    const run: Run = (sql) => execSql(ctx, sql, { tuplesOnly: true });

    const backOffice = await checkBackOfficeChange(run);
    const customer = await checkCustomerChange(run);
    const bulk = await checkBulkCancel(run);
    const unchanged = await checkUnchangedStatus(run);
    const read = await checkCustomersReadOwn(run);
    const write = await checkCustomersCannotWrite(run);

    const checks: CheckResult[] = [
      checkMigrationsWereApplied(migrations),
      backOffice,
      customer,
      bulk,
      unchanged,
      read,
      write,
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated the order status timeline',
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
    name: 'the agent read the Postgres Triggers guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
