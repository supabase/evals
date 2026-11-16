import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';
import {
  applyPendingMigrations,
  checkChangeWasAMigration,
  checkMigrationsWereApplied,
} from './migrations.js';
import {
  CHECK,
  checkGuestCannotReview,
  checkGuestCart,
  checkGuestReads,
  checkMemberReview,
  checkSessionStarts,
  type Run,
  setupWorld,
  startGuest,
  type World,
} from './probes.js';

const GUIDE_PATH = 'guides/auth/auth-anonymous';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const migrations = await applyPendingMigrations(ctx);
    const run: Run = (sql) => execSql(ctx, sql);

    const started = await startGuest(ctx);
    const setup =
      'guest' in started
        ? await setupWorld(ctx, run, started.guest)
        : { failure: started.failure };
    const world = 'world' in setup ? setup.world : undefined;
    const blocked = 'failure' in setup ? setup.failure : 'no world';

    const checks: CheckResult[] = [
      checkMigrationsWereApplied(migrations),
      checkChangeWasAMigration(ctx.hostWorkspace),
      checkSessionStarts(started),
      await gated(world, blocked, CHECK.guestReads, (w) => checkGuestReads(w)),
      await gated(world, blocked, CHECK.guestCart, (w) =>
        checkGuestCart(ctx, w)
      ),
      await gated(world, blocked, CHECK.memberReview, (w) =>
        checkMemberReview(ctx, w)
      ),
      await gated(world, blocked, CHECK.guestReview, (w) =>
        checkGuestCannotReview(ctx, w)
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
          name: 'scorer evaluated who may post a review',
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
  blocked: string,
  name: string,
  probe: (world: World) => Promise<CheckResult>
): Promise<CheckResult> {
  if (!world) {
    return { name, passed: false, notes: `not run: ${blocked}` };
  }
  try {
    return await probe(world);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: message.slice(0, 300) };
  }
}

async function execSql(
  ctx: LocalStackEvalContext,
  sql: string
): Promise<{ ok: boolean; message: string }> {
  try {
    return await psql(ctx, sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: message.slice(0, 300) };
  }
}

async function psql(
  ctx: LocalStackEvalContext,
  sql: string
): Promise<{ ok: boolean; message: string }> {
  const encoded = Buffer.from(sql, 'utf8').toString('base64');
  const result = await ctx.exec(
    stripIndent`
      DB_URL=$(supabase status -o json 2>/dev/null | node -e 'let input = ""; process.stdin.on("data", data => input += data); process.stdin.on("end", () => console.log(JSON.parse(input).DB_URL));')
      echo ${encoded} | base64 -d | psql "$DB_URL" -v ON_ERROR_STOP=1 -q
    `
  );
  if (result.ok) return { ok: true, message: '' };
  const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  const lines = output.split('\n').map((line) => line.trim());
  const named = lines.filter((line) => /^(ERROR|DETAIL)\b/.test(line));
  return {
    ok: false,
    message: (named.length > 0 ? named.join(' ') : output.trim()).slice(0, 300),
  };
}

function checkGuideWasRead(ctx: LocalStackEvalContext): CheckResult {
  const calls = buildDocsResult(ctx.toolCalls).calls.filter((call) =>
    call.pages?.some((page) => page.url.includes(GUIDE_PATH))
  );
  const withContent = calls.filter((call) => call.hasContent);
  return {
    name: 'the agent read the anonymous sign-ins guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
