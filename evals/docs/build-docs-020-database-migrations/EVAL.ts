import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { execSql } from '../lib/exec-sql.js';
import {
  addedMigrations,
  checkAddedMigration,
  checkHistoryUntouched,
  seedMigrations,
  workspaceMigrations,
} from './migrations.js';
import {
  CHECK,
  checkExistingOrders,
  checkLocalDatabase,
  checkNeverNone,
  checkPlacingOrders,
  checkRebuilt,
  checkRollout,
  newMarker,
  type Query,
  type Rollout,
  rollOut,
} from './probes.js';

const GUIDE_PATH = 'guides/deployment/database-migrations';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const query: Query = (sql) => ctx.query(sql);
    const seed = seedMigrations();
    const workspace = workspaceMigrations(ctx.hostWorkspace);

    // Phase order matters. The file reads and the look at the agent's own
    // database come first, before the scorer changes anything. The rollout
    // runs in a scratch database, so it leaves the agent's untouched. The
    // reset goes last because it wipes the agent's database.
    const history = checkHistoryUntouched(seed, workspace);
    const added = checkAddedMigration(seed, workspace);
    const local = await guard(CHECK.local, () => checkLocalDatabase(query));

    const rollout = await runRollout(
      ctx,
      seed,
      addedMigrations(seed, workspace)
    );

    const rebuild = await guard(CHECK.rebuild, async () =>
      checkRebuilt(await resetDatabase(ctx), query)
    );

    const checks: CheckResult[] = [
      history,
      added,
      local,
      ...rollout,
      rebuild,
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated whether the change ships',
          passed: false,
          notes: message,
        },
      ],
    };
  }
};

export default scorer;

/** The four checks that need a database holding orders, built and dropped here. */
async function runRollout(
  ctx: LocalStackEvalContext,
  seed: ReturnType<typeof seedMigrations>,
  added: ReturnType<typeof addedMigrations>
): Promise<CheckResult[]> {
  const marker = newMarker();
  const database = `scratch_${marker}`;
  const on = { tuplesOnly: true, database };
  const run = (sql: string) => execSql(ctx, sql, on);

  const created = await execSql(ctx, `create database ${database};`);
  if (!created.ok) {
    const failed: Rollout = {
      ok: false,
      reason: `scorer setup: could not create a scratch database: ${created.message}`,
    };
    return [checkRollout(failed), ...blockedChecks(failed)];
  }
  try {
    const rollout = await rollOut(run, marker, seed, added);
    return [
      checkRollout(rollout),
      await guard(CHECK.existing, () =>
        checkExistingOrders(run, marker, rollout)
      ),
      await guard(CHECK.placing, () =>
        checkPlacingOrders(run, marker, rollout)
      ),
      await guard(CHECK.never, () => checkNeverNone(run, marker, rollout)),
    ];
  } finally {
    await execSql(ctx, `drop database if exists ${database} with (force);`);
  }
}

function blockedChecks(rollout: Rollout & { ok: false }): CheckResult[] {
  return [CHECK.existing, CHECK.placing, CHECK.never].map((name) => ({
    name,
    passed: false,
    notes: `not run: ${rollout.reason}`,
  }));
}

/** The CLI's own reset, as a teammate would run it after pulling. Never throws. */
async function resetDatabase(
  ctx: LocalStackEvalContext
): Promise<{ ok: boolean; message: string }> {
  try {
    const result = await ctx.exec('supabase db reset 2>&1', {
      timeoutMs: 300_000,
    });
    return result.exitCode === 0
      ? { ok: true, message: '' }
      : { ok: false, message: resetError(result.stdout ?? '') };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: message.slice(0, 300) };
  }
}

// Hoist the database's own error over the CLI's progress lines.
function resetError(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const named = lines.filter((line) =>
    /^(ERROR|FATAL|DETAIL|HINT|At statement)\b/i.test(line)
  );
  return (
    named.length > 0 ? named.join(' ') : (lines.at(-1) ?? 'no output')
  ).slice(0, 300);
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
    name: 'the agent read the database migrations guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
