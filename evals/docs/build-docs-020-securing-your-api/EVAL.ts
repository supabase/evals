import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';

import {
  checkAnonRunsOnlyTheSearch,
  checkObjectsExist,
  loadObjects,
} from './catalog.js';
import { NAMES } from './names.js';
import {
  applyPendingMigrations,
  checkMigrationsWereApplied,
} from './migrations.js';
import {
  checkNoClientRunsTheNightlyJob,
  checkNoClientWritesNotes,
  checkNotesReadableByNoClient,
  checkRepliesReadableByTheirCustomerOnly,
  checkServerKeyReachesRepliesAndNotes,
  checkServerKeyRunsTheNightlyJob,
  checkVisitorCanSearchHelp,
  seedMarkers,
  setupWorld,
  type World,
} from './probes.js';

const GUIDE_PATH = 'guides/api/securing-your-api';

// Phase order is load-bearing.
//
// 1. Apply the agent's migrations first. Correct SQL left unapplied would red
//    every check that reads the database, so the lifecycle gets a check of its
//    own and costs one.
// 2. Read the catalog before anything writes, so nothing the probes add is in
//    scope.
// 3. Probes that only read, then the one that writes and must fail, then the
//    one that would mutate if a leak exists (it calls the nightly job as a
//    client). The server key's own writes come last: they insert rows and close
//    a ticket, and a ticket they closed must not be mistaken for a client's.
const scorer: LocalStackScorer = async (ctx) => {
  try {
    const migrations = await applyPendingMigrations(ctx);
    const objects = await loadObjects(ctx);

    const exists = checkObjectsExist(objects);
    const visitorFunctions = await guarded(NAMES.visitorFunctions, () =>
      checkAnonRunsOnlyTheSearch(ctx)
    );

    const setup = await guardedSetup(ctx);
    const world = 'world' in setup ? setup.world : undefined;
    const blocked = 'failure' in setup ? setup.failure : undefined;
    if (world && objects.replies && objects.notes) {
      await seedMarkers(ctx, world);
    }

    const checks: CheckResult[] = [
      checkMigrationsWereApplied(migrations),
      exists,
      visitorFunctions,
      await needs(
        world,
        blocked,
        objects.replies,
        NAMES.replies,
        checkRepliesReadableByTheirCustomerOnly
      ),
      await needs(
        world,
        blocked,
        objects.notes,
        NAMES.notes,
        checkNotesReadableByNoClient
      ),
      await needs(
        world,
        blocked,
        objects.notes && objects.replies,
        NAMES.writes,
        (w) => checkNoClientWritesNotes(ctx, w)
      ),
      await needs(
        world,
        blocked,
        true,
        NAMES.search,
        checkVisitorCanSearchHelp
      ),
      await needs(world, blocked, objects.closeStale, NAMES.clientJob, (w) =>
        checkNoClientRunsTheNightlyJob(ctx, w)
      ),
      await needs(
        world,
        blocked,
        objects.replies && objects.notes,
        NAMES.serverTables,
        (w) => checkServerKeyReachesRepliesAndNotes(ctx, w)
      ),
      await needs(world, blocked, objects.closeStale, NAMES.serverJob, (w) =>
        checkServerKeyRunsTheNightlyJob(ctx, w)
      ),
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated what the Data API reaches',
          passed: false,
          notes: message,
        },
      ],
    };
  }
};

export default scorer;

// A blocked path fails its checks with a reason. It never skips them, and it
// never reports green for a run that produced nothing.
async function needs(
  world: World | undefined,
  blocked: string | undefined,
  present: boolean,
  name: string,
  probe: (world: World) => Promise<CheckResult>
): Promise<CheckResult> {
  if (!world) {
    return { name, passed: false, notes: `not run: ${blocked ?? 'no probes'}` };
  }
  if (!present) {
    return {
      name,
      passed: false,
      notes: 'not run: the object this check probes does not exist',
    };
  }
  return guarded(name, () => probe(world));
}

// A throwing step costs one check, not the whole result.
async function guarded(
  name: string,
  run: () => Promise<CheckResult>
): Promise<CheckResult> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: `not run: ${message.slice(0, 300)}` };
  }
}

async function guardedSetup(
  ctx: LocalStackEvalContext
): Promise<{ world: World } | { failure: string }> {
  try {
    return await setupWorld(ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { failure: message.slice(0, 300) };
  }
}

// A search_docs hit carries the guide's url in its result, not its request, so
// reuse the harness's own resolution rather than scanning the raw tool call.
function checkGuideWasRead(ctx: LocalStackEvalContext): CheckResult {
  const calls = buildDocsResult(ctx.toolCalls).calls.filter((call) =>
    call.pages?.some((page) => page.url.includes(GUIDE_PATH))
  );
  const withContent = calls.filter((call) => call.hasContent);
  return {
    name: NAMES.guideRead,
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
