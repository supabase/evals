import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { messageOf } from '../lib/local-stack.js';
import {
  applyPendingMigrations,
  checkMigrationsWereApplied,
} from './migrations.js';
import {
  checkBackup,
  checkDesktop,
  checkNoFullAccessKey,
  installDependencies,
  notRun,
  PROBE_CHECKS,
  probeBackup,
  probeDesktop,
  readBodies,
  readStack,
  removeScratch,
  type Stack,
  setupWorld,
} from './probes.js';

const GUIDE_PATH = 'guides/storage/s3/authentication';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const stack = await readStack(ctx).then(
      (value): { stack: Stack } => ({ stack: value }),
      (error: unknown) => ({ failure: messageOf(error) })
    );
    const noFullAccessKey = checkNoFullAccessKey(
      ctx.hostWorkspace,
      'stack' in stack ? stack.stack : undefined
    );
    const migrations = await applyPendingMigrations(ctx);
    const installed = await installDependencies(ctx);

    const probes =
      'stack' in stack
        ? await runProbes(ctx, stack.stack, installed)
        : PROBE_CHECKS.map((name) => notRun(name, stack.failure));

    const checks: CheckResult[] = [
      checkMigrationsWereApplied(migrations),
      installed,
      ...probes,
      noFullAccessKey,
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated who can reach the notes',
          passed: false,
          notes: messageOf(error),
        },
      ],
    };
  }
};

export default scorer;

async function runProbes(
  ctx: LocalStackEvalContext,
  stack: Stack,
  installed: CheckResult
): Promise<CheckResult[]> {
  if (!installed.passed) {
    return PROBE_CHECKS.map((name) =>
      notRun(name, 'the dependencies did not install')
    );
  }
  const setup = await setupWorld(ctx, stack);
  if ('failure' in setup) {
    return PROBE_CHECKS.map((name) => notRun(name, setup.failure));
  }
  const { world } = setup;
  const backup = await probeBackup(ctx, world);
  const desktop = await probeDesktop(ctx, world);
  const bodies = await readBodies(ctx, world);
  await removeScratch(ctx, world.scratch);

  const results = [
    ...checkDesktop(world, desktop, bodies),
    checkBackup(world, backup),
  ];
  return PROBE_CHECKS.map(
    (name) =>
      results.find((result) => result.name === name) ??
      notRun(name, `no result for ${name}`)
  );
}

function checkGuideWasRead(ctx: LocalStackEvalContext): CheckResult {
  const calls = buildDocsResult(ctx.toolCalls).calls.filter((call) =>
    call.pages?.some((page) => page.url.includes(GUIDE_PATH))
  );
  const withContent = calls.filter((call) => call.hasContent);
  return {
    name: 'the agent read the S3 authentication guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
