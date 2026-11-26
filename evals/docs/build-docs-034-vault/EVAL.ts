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
  checkKeyHidden,
  checkKeyNotInDatabase,
  checkKeyNotInRepo,
  checkKeyStored,
  checkLinkAccepted,
  checkLinkFollowsRotation,
  type Run,
  requestLink,
} from './probes.js';

const GUIDE_PATH = 'guides/database/vault';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const inRepo = await checkKeyNotInRepo(ctx);
    const migrations = await applyPendingMigrations(ctx);
    const run: Run = (sql) => execSql(ctx, sql, { tuplesOnly: true });

    const stored = await checkKeyStored(run, ctx.hostWorkspace);
    const inDatabase = await checkKeyNotInDatabase(run);
    const hidden = await checkKeyHidden(run);
    const link = checkLinkAccepted(await requestLink(run));
    const rotated = await checkLinkFollowsRotation(run);

    const checks: CheckResult[] = [
      checkMigrationsWereApplied(migrations),
      stored,
      inDatabase,
      inRepo,
      link,
      rotated,
      hidden,
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated how the signing key is kept',
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
    name: 'the agent read the Vault guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
