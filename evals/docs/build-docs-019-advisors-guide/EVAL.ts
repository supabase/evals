import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { execSql } from '../lib/exec-sql.js';
import {
  checkNoUnindexedForeignKeys,
  checkSeededTablesAreTables,
  FINDINGS_CHECK,
  type Query,
  TABLES_CHECK,
} from './findings.js';
import {
  applyPendingMigrations,
  checkMigrationsWereApplied,
} from './migrations.js';
import {
  checkRelationshipsRefuseOrphans,
  checkTwoAppointmentsBooked,
  type Probe,
  PROBE_CHECK,
  type Run,
  runProbe,
} from './probes.js';
import { checkReplayClearsFindings, REPLAY_CHECK } from './replay.js';
import {
  checkReportMentionsUnusedIndexes,
  REPORT_CHECK,
  readUnusedIndexes,
} from './report.js';

const GUIDE_PATH = 'guides/observability/advisors';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const migrations = await applyPendingMigrations(ctx);
    const query: Query = (sql) => ctx.query(sql);
    const run: Run = (sql) => execSql(ctx, sql, { tuplesOnly: true });

    const unused = await readUnusedIndexes(query);
    const tables = await guard(TABLES_CHECK, () =>
      checkSeededTablesAreTables(query)
    );
    const findings = await guard(FINDINGS_CHECK, () =>
      checkNoUnindexedForeignKeys(query)
    );
    const probe = await probeOrFailure(run);
    const replay = await guard(REPLAY_CHECK, () =>
      checkReplayClearsFindings(run, ctx.hostWorkspace)
    );
    const report = await guard(REPORT_CHECK, () =>
      checkReportMentionsUnusedIndexes(
        (args) => ctx.judge(args),
        ctx.agentReport,
        unused
      )
    );

    const checks: CheckResult[] = [
      checkMigrationsWereApplied(migrations),
      replay,
      tables,
      findings,
      checkRelationshipsRefuseOrphans(probe),
      checkTwoAppointmentsBooked(probe),
      report,
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated whether the findings were fixed',
          passed: false,
          notes: message,
        },
      ],
    };
  }
};

export default scorer;

async function probeOrFailure(run: Run): Promise<Probe> {
  try {
    return await runProbe(run);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { failure: message.slice(0, 300) };
  }
}

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
    name: 'the agent read the advisors guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
