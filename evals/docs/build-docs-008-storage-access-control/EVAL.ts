import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import {
  checkBucketExists,
  checkBucketsArePrivate,
  checkRlsEnabled,
  loadBuckets,
  pickProbeBucket,
} from './buckets.js';
import {
  applyPendingMigrations,
  checkMigrationsWereApplied,
} from './migrations.js';
import {
  checkAnonCannotRead,
  checkOwnerCanRead,
  checkOwnerCanUpload,
  checkOwnerSeesOwnPicture,
  checkPublicUrlDoesNotServe,
  checkStrangerCannotList,
  checkStrangerCannotRead,
  checkStrangerCannotWrite,
  setupProbes,
  type Probes,
} from './probes.js';

const GUIDE_PATH = 'guides/storage/security/access-control';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const migrations = await applyPendingMigrations(ctx);
    const buckets = await loadBuckets(ctx);
    const rlsEnabled = await checkRlsEnabled(ctx);
    const bucket = pickProbeBucket(buckets);
    const setup = bucket
      ? await setupProbes(ctx, bucket)
      : { failure: 'the agent created no bucket to probe' };
    const probes = 'probes' in setup ? setup.probes : undefined;
    const blocked = 'failure' in setup ? setup.failure : undefined;
    const checks: CheckResult[] = [
      checkMigrationsWereApplied(migrations),
      checkBucketExists(buckets),
      checkBucketsArePrivate(buckets),
      rlsEnabled,
      await gated(
        probes,
        blocked,
        'the owner can upload their own profile picture',
        (p) => checkOwnerCanUpload(ctx, p)
      ),
      await gated(
        probes,
        blocked,
        'the owner can see their own profile picture listed',
        checkOwnerSeesOwnPicture
      ),
      await gated(
        probes,
        blocked,
        'the owner can read their own profile picture back',
        checkOwnerCanRead
      ),
      await gated(
        probes,
        blocked,
        "another signed-in person cannot read the owner's profile picture",
        checkStrangerCannotRead
      ),
      await gated(
        probes,
        blocked,
        "another signed-in person cannot list the owner's profile pictures",
        checkStrangerCannotList
      ),
      await gated(
        probes,
        blocked,
        "a signed-out visitor cannot read the owner's profile picture",
        checkAnonCannotRead
      ),
      await gated(
        probes,
        blocked,
        "the owner's profile picture is not served over the bucket's public url",
        checkPublicUrlDoesNotServe
      ),
      await gated(
        probes,
        blocked,
        "another signed-in person cannot write into the owner's own area",
        (p) => checkStrangerCannotWrite(ctx, p)
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
          name: 'scorer evaluated who can reach a profile picture',
          passed: false,
          notes: message,
        },
      ],
    };
  }
};

export default scorer;

async function gated(
  probes: Probes | undefined,
  blocked: string | undefined,
  name: string,
  probe: (probes: Probes) => Promise<CheckResult>
): Promise<CheckResult> {
  if (!probes) {
    return { name, passed: false, notes: `not run: ${blocked ?? 'no probes'}` };
  }
  return probe(probes);
}

function checkGuideWasRead(ctx: LocalStackEvalContext): CheckResult {
  const calls = buildDocsResult(ctx.toolCalls).calls.filter((call) =>
    call.pages?.some((page) => page.url.includes(GUIDE_PATH))
  );
  const withContent = calls.filter((call) => call.hasContent);
  return {
    name: 'the agent read the Storage Access Control guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
