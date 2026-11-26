import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { execSql } from '../lib/exec-sql.js';
import { openToolSession, readTool, SETTINGS_FILE } from './login.js';
import {
  applyPendingMigrations,
  checkMigrationsWereApplied,
} from './migrations.js';
import {
  CHECK,
  checkAccount,
  checkCreate,
  checkPassword,
  checkPayroll,
  checkReads,
  checkSignIn,
  checkWrites,
  type Query,
  type Run,
  setupWorld,
} from './probes.js';

const GUIDE_PATH = 'guides/database/postgres/roles';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    // An unapplied migration should cost one check, not all of them. The agent
    // may just as well have made the account straight on the database, which
    // this leaves alone.
    const migrations = await applyPendingMigrations(ctx);
    const tool = await probeTool(ctx);

    const checks: CheckResult[] = [
      checkMigrationsWereApplied(migrations),
      tool.signIn,
      tool.account,
      tool.password,
      tool.reads,
      tool.writes,
      tool.create,
      tool.payroll,
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated what the tool can do with the database',
          passed: false,
          notes: message,
        },
      ],
    };
  }
};

export default scorer;

type ToolChecks = Record<keyof typeof CHECK, CheckResult>;

// Every branch fills every key, so a check that could not run still reports
// under its own name.
async function probeTool(ctx: LocalStackEvalContext): Promise<ToolChecks> {
  const notRun = (why: string, except: (keyof typeof CHECK)[] = []) =>
    Object.fromEntries(
      (Object.keys(CHECK) as (keyof typeof CHECK)[])
        .filter((key) => !except.includes(key))
        .map((key) => [
          key,
          { name: CHECK[key], passed: false, notes: `not run: ${why}` },
        ])
    ) as Partial<ToolChecks>;

  const read = readTool(ctx.hostWorkspace);
  if ('failure' in read) {
    return {
      ...notRun(`${SETTINGS_FILE} gives no account to sign in with`),
      signIn: { name: CHECK.signIn, passed: false, notes: read.failure },
    } as ToolChecks;
  }

  const { tool } = read;
  const session = await openToolSession(ctx, tool);
  if ('failure' in session) {
    return {
      ...notRun(session.failure),
      signIn: { name: CHECK.signIn, passed: false, notes: session.failure },
      password: checkPassword(tool),
    } as ToolChecks;
  }

  const { asTool } = session;
  const query: Query = (sql) => ctx.query(sql);
  const run: Run = (sql) => execSql(ctx, sql);
  const signIn = checkSignIn(tool, await asTool('SELECT current_user;'));
  const password = checkPassword(tool);
  const setup = signIn.passed ? await setupWorld(query, run) : undefined;
  if (setup === undefined || 'failure' in setup) {
    return {
      ...notRun(
        setup === undefined
          ? "the tool's connection string does not sign in"
          : setup.failure
      ),
      signIn,
      password,
    } as ToolChecks;
  }

  // The writes go after the reads and the payroll read goes last, so a tool
  // that is able to change rows is still measured reading them.
  const { world } = setup;
  return {
    signIn,
    password,
    account: await guard(CHECK.account, () => checkAccount(query, tool)),
    reads: await guard(CHECK.reads, () => checkReads(query, asTool, world)),
    writes: await guard(CHECK.writes, () => checkWrites(query, asTool, world)),
    create: await guard(CHECK.create, () =>
      checkCreate(query, run, asTool, world)
    ),
    payroll: await guard(CHECK.payroll, () => checkPayroll(query, asTool)),
  };
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
    name: 'the agent read the postgres roles guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
