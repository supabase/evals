import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { restartStack } from '../lib/local-stack.js';
import { turnCodesOn } from './config.js';
import {
  applyPendingMigrations,
  checkMigrationsWereApplied,
} from './migrations.js';
import {
  CHECK,
  checkCodesAllowed,
  checkHalfway,
  checkPlainReads,
  checkPlainWrites,
  checkSkippedReads,
  checkSkippedWrites,
  checkStackStarts,
  checkStaleDevice,
  checkTypedReads,
  checkTypedWrites,
  notRun,
  probeCodes,
  type Setup,
  setupWorld,
  signInWithCode,
  type World,
} from './probes.js';

const GUIDE_PATH = /guides\/auth\/auth-mfa(?:\.md)?(?:[?#]|$)/;

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const started = await restartStack(ctx);
    const migrations = await applyPendingMigrations(ctx);
    const codes = started.ok
      ? await probeCodes(ctx)
      : { ok: false as const, message: started.message };
    const ready = !started.ok
      ? started
      : codes.ok
        ? codes
        : await turnCodesOn(ctx);
    const setup: Setup = ready.ok
      ? await setupWorld(ctx)
      : { ok: false, message: ready.message };
    const world = setup.ok ? setup.world : undefined;
    const setupFailure = setup.ok ? '' : setup.message;
    const probe = (
      name: string,
      run: (world: World) => Promise<CheckResult>
    ): Promise<CheckResult> => gated(world, setupFailure, name, run);

    const plainReads = await probe(CHECK.plainReads, (w) => checkPlainReads(w));
    const plainWrites = await probe(CHECK.plainWrites, (w) =>
      checkPlainWrites(ctx, w)
    );
    const halfway = await probe(CHECK.halfway, (w) => checkHalfway(w));
    const skippedReads = await probe(CHECK.skippedReads, (w) =>
      checkSkippedReads(ctx, w)
    );
    const staleDevice = await probe(CHECK.staleDevice, (w) =>
      checkStaleDevice(w)
    );
    const typedSignIn = world
      ? await signInWithCode(ctx, world)
      : { ok: false as const, message: setupFailure };
    const typedReads = await probe(CHECK.typedReads, (w) =>
      checkTypedReads(typedSignIn, w)
    );
    const typedWrites = await probe(CHECK.typedWrites, (w) =>
      checkTypedWrites(ctx, typedSignIn, w)
    );
    const skippedWrites = await probe(CHECK.skippedWrites, (w) =>
      checkSkippedWrites(ctx, w)
    );

    const checks: CheckResult[] = [
      checkStackStarts(started),
      checkMigrationsWereApplied(migrations),
      started.ok
        ? checkCodesAllowed(codes)
        : notRun(CHECK.codesAllowed, started.message),
      plainReads,
      plainWrites,
      halfway,
      skippedReads,
      skippedWrites,
      staleDevice,
      typedReads,
      typedWrites,
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated who can open a journal',
          passed: false,
          notes: message,
        },
      ],
    };
  }
};

export default scorer;

async function gated(
  world: World | undefined,
  setupFailure: string,
  name: string,
  run: (world: World) => Promise<CheckResult>
): Promise<CheckResult> {
  if (!world) return notRun(name, setupFailure);
  try {
    return await run(world);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: message.slice(0, 300) };
  }
}

function checkGuideWasRead(ctx: LocalStackEvalContext): CheckResult {
  const calls = buildDocsResult(ctx.toolCalls).calls.filter((call) =>
    call.pages?.some((page) => GUIDE_PATH.test(page.url))
  );
  const withContent = calls.filter((call) => call.hasContent);
  return {
    name: 'the agent read the multi-factor authentication guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
