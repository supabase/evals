import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { openToolSession, readTool, SETTINGS_FILE } from './login.js';
import { execSql } from '../lib/exec-sql.js';
import {
  applyPendingMigrations,
  checkMigrationsWereApplied,
} from './migrations.js';
import {
  CHECK,
  checkAccount,
  checkConfined,
  checkLater,
  checkMigrated,
  checkSignIn,
  type Query,
} from './probes.js';

const GUIDE_PATH = 'guides/database/prisma';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    // An unapplied Supabase migration should cost one check, not all of them.
    // The agent may just as well have made the account straight on the
    // database, which this leaves alone. Prisma's own migrations are Prisma's
    // to run and are never applied here: what they left is the evidence.
    const migrations = await applyPendingMigrations(ctx);
    const probe = await probeAccount(ctx);

    const checks: CheckResult[] = [
      checkMigrationsWereApplied(migrations),
      probe.signIn,
      probe.account,
      probe.migrated,
      probe.confined,
      probe.later,
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated what Prisma connects as',
          passed: false,
          notes: message,
        },
      ],
    };
  }
};

export default scorer;

type Probe = Record<keyof typeof CHECK, CheckResult>;

// Every branch fills every key, so a check that could not run still reports
// under its own name.
async function probeAccount(ctx: LocalStackEvalContext): Promise<Probe> {
  const blocked = (
    why: string,
    except: (keyof typeof CHECK)[] = []
  ): Partial<Probe> =>
    Object.fromEntries(
      (Object.keys(CHECK) as (keyof typeof CHECK)[])
        .filter((key) => !except.includes(key))
        .map((key) => [
          key,
          { name: CHECK[key], passed: false, notes: `not run: ${why}` },
        ])
    );

  const read = readTool(ctx.hostWorkspace);
  if ('failure' in read) {
    return {
      ...blocked(`${SETTINGS_FILE} gives no account to sign in with`),
      signIn: { name: CHECK.signIn, passed: false, notes: read.failure },
    } as Probe;
  }

  const { tool } = read;
  const session = await openToolSession(ctx, tool);
  if ('failure' in session) {
    return {
      ...blocked(session.failure),
      signIn: { name: CHECK.signIn, passed: false, notes: session.failure },
    } as Probe;
  }

  const { asTool } = session;
  const query: Query = (sql) => ctx.query(sql);
  const signIn = checkSignIn(tool, await asTool('SELECT current_user;'));
  if (!signIn.passed) {
    return {
      ...blocked("Prisma's connection string does not sign in"),
      signIn,
    } as Probe;
  }
  return {
    signIn,
    account: await checkAccount(query, tool),
    migrated: await checkMigrated(query, tool),
    confined: await checkConfined(query, asTool),
    // Last, because it adds a table of its own and drops it again.
    later: await checkLater((sql) => execSql(ctx, sql), asTool),
  };
}

function checkGuideWasRead(ctx: LocalStackEvalContext): CheckResult {
  const calls = buildDocsResult(ctx.toolCalls).calls.filter((call) =>
    call.pages?.some((page) => page.url.includes(GUIDE_PATH))
  );
  const withContent = calls.filter((call) => call.hasContent);
  return {
    name: 'the agent read the Prisma guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
