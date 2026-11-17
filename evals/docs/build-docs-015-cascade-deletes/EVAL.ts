import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { execSql } from '../lib/exec-sql.js';
import {
  applyPendingMigrations,
  checkChangeWasAMigration,
  checkMigrationsWereApplied,
} from './migrations.js';
import {
  CHECK,
  checkClosedTeamRowsGone,
  checkInvoicesKept,
  checkLeaverCommentsKept,
  checkOtherTeamUntouched,
  checkTeamDeleteSucceeds,
  deleteClosedTeam,
  type Query,
  type Run,
  setupWorld,
} from './probes.js';

const GUIDE_PATH = 'guides/database/postgres/cascade-deletes';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    // An unapplied migration should cost one check, not all of them.
    const migrations = await applyPendingMigrations(ctx);
    const query: Query = (sql) => ctx.query(sql);
    const run: Run = (sql) => execSql(ctx, sql);

    const setup = await setupWorld(run);

    // The leaver goes first, so the team delete also has to clear a comment
    // with no author.
    let probes: CheckResult[];
    if ('failure' in setup) {
      probes = Object.values(CHECK).map((name) => ({
        name,
        passed: false,
        notes: `not run: ${setup.failure}`,
      }));
    } else {
      const { world } = setup;
      const leaver = await guard(CHECK.leaver, () =>
        checkLeaverCommentsKept(query, run, world)
      );
      const deleted = await deleteClosedTeam(run, world);
      probes = [
        leaver,
        checkTeamDeleteSucceeds(deleted),
        await guard(CHECK.rowsGone, () =>
          checkClosedTeamRowsGone(query, world, deleted)
        ),
        await guard(CHECK.invoices, () =>
          checkInvoicesKept(query, world, deleted)
        ),
        await guard(CHECK.otherTeam, () =>
          checkOtherTeamUntouched(query, world, deleted)
        ),
      ];
    }

    const checks: CheckResult[] = [
      checkMigrationsWereApplied(migrations),
      checkChangeWasAMigration(ctx.hostWorkspace),
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
          name: 'scorer evaluated what deleting a team removes',
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
    name: 'the agent read the cascade deletes guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
