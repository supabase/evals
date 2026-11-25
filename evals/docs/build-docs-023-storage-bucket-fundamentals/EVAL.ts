import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { checkDeclaredBucketsExist, seedDeclaredBuckets } from './lifecycle.js';
import {
  applyPendingMigrations,
  checkMigrationsWereApplied,
} from './migrations.js';
import {
  CHECK,
  checkAnyoneCanSee,
  checkLinkAloneDoesNotOpen,
  type Bucket,
  newWorld,
  probeBucket,
  type Store,
  type World,
} from './probes.js';
import { listBuckets, readStack, realStore } from './stack.js';

const GUIDE_PATH = 'guides/storage/buckets/fundamentals';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    // The lifecycle steps come first and each costs one check: a bucket
    // written into a migration or declared in config.toml but never applied
    // would otherwise red every probe below for a step this page says nothing
    // about.
    const migrations = await applyPendingMigrations(ctx);
    const declared = await seedDeclaredBuckets(ctx);

    const probes = await runProbes(ctx);

    const checks: CheckResult[] = [
      checkMigrationsWereApplied(migrations),
      checkDeclaredBucketsExist(declared),
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
          name: 'scorer evaluated the buckets',
          passed: false,
          notes: message,
        },
      ],
    };
  }
};

export default scorer;

// Uploads only ever add objects under a per-run marker, and the visibility
// reads need a stored object, so they follow the uploads. Nothing here deletes
// anything: storage.objects refuses deletes from the scorer's role.
async function runProbes(ctx: LocalStackEvalContext): Promise<CheckResult[]> {
  let store: ReturnType<typeof realStore>;
  let known: string;
  try {
    store = realStore(ctx, await readStack(ctx));
    known = await listBuckets(ctx);
  } catch (error) {
    const reason = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, 300);
    return Object.values(CHECK).map((name) => ({
      name,
      passed: false,
      notes: `not run: ${reason}`,
    }));
  }
  const world = newWorld();
  const photos = await probe(store, world, known, 'photos', {
    accepted: CHECK.photosAccepted,
    size: CHECK.photosSize,
    type: CHECK.photosType,
    visibility: CHECK.photosVisible,
    seen: checkAnyoneCanSee,
  });
  const invoices = await probe(store, world, known, 'invoices', {
    accepted: CHECK.invoicesAccepted,
    size: CHECK.invoicesSize,
    type: CHECK.invoicesType,
    visibility: CHECK.invoicesHidden,
    seen: checkLinkAloneDoesNotOpen,
  });
  return [...photos, ...invoices];
}

type Names = {
  accepted: string;
  size: string;
  type: string;
  visibility: string;
  seen: (store: Store, world: World, bucket: Bucket) => Promise<CheckResult>;
};

// One bucket's checks. A thrown error costs this bucket's checks only.
async function probe(
  store: Store,
  world: World,
  known: string,
  which: 'photos' | 'invoices',
  names: Names
): Promise<CheckResult[]> {
  try {
    const result = await probeBucket(store, world, which, names, known);
    const seen = await guard(names.visibility, () =>
      names.seen(store, world, result.bucket)
    );
    return [...result.checks, seen];
  } catch (error) {
    const message = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, 300);
    return [names.accepted, names.size, names.type, names.visibility].map(
      (name) => ({
        name,
        passed: false,
        notes: `not run: ${message}`,
      })
    );
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
    name: 'the agent read the storage buckets guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
