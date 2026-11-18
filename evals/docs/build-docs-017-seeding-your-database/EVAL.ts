import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { execSql } from '../lib/exec-sql.js';
import {
  CHECK,
  checkNewRows,
  checkNoSampleDataWithoutSeed,
  checkResetSucceeds,
  checkSampleRows,
  type Query,
  type Run,
  resetDatabase,
} from './probes.js';

const GUIDE_PATH = 'guides/local-development/seeding-your-database';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const query: Query = (sql) => ctx.query(sql);
    const run: Run = (sql) => execSql(ctx, sql, { tuplesOnly: true });

    // The scorer's own reset, so the result doesn't depend on whether the
    // agent ran one. The reset without sample data goes last, because it
    // wipes what the other probes read.
    const full = await resetDatabase(ctx, { withSampleData: true });
    const rows = await guard(CHECK.rows, () => checkSampleRows(query, full));
    const inserts = await guard(CHECK.inserts, () => checkNewRows(run, full));
    const bare = await resetDatabase(ctx, { withSampleData: false });
    const noSeed = await guard(CHECK.noSeed, () =>
      checkNoSampleDataWithoutSeed(query, bare)
    );

    const checks: CheckResult[] = [
      checkResetSucceeds(full),
      rows,
      inserts,
      noSeed,
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated what a reset loads',
          passed: false,
          notes: message,
        },
      ],
    };
  }
};

export default scorer;

async function guard(
  name: string,
  run: () => Promise<CheckResult>
): Promise<CheckResult> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: message.slice(0, 300) };
  }
}

function checkGuideWasRead(ctx: LocalStackEvalContext): CheckResult {
  const calls = buildDocsResult(ctx.toolCalls).calls.filter((call) =>
    call.pages?.some((page) => page.url.includes(GUIDE_PATH))
  );
  const withContent = calls.filter((call) => call.hasContent);
  return {
    name: 'the agent read the seeding guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
