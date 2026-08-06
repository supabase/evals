import {
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';

// Email+password auth benchmark: the prompt asks the agent to finish the
// app's auth layer (app/src/auth.mjs) against the running local stack and
// never names supabase-js — the "uses @supabase/supabase-js" check is
// GATING. On top of SDK discovery it measures driving auth correctly:
// passing the display name as signup user metadata (the seeded profiles
// trigger reads raw_user_meta_data), handling bad credentials gracefully,
// and reading the RLS-scoped profile with the session actually attached.

const APP_DIR = 'app';
const DRIVER = 'eval-driver.mjs';
const DRIVER_MARKER = '___EVAL_DRIVER___';

// Runs inside the sandbox, in one process, exactly like the app would use
// the module: sign up, fail a sign-in, sign in, read the profile.
const DRIVER_SOURCE = `
import { signUp, signIn, getMyProfile } from './src/auth.mjs';

const [email, password, displayName, wrongPassword] = process.argv.slice(2);
const out = {};
const step = async (name, fn) => {
  try {
    out[name] = await fn();
  } catch (error) {
    out[name] = {
      threw: String(error instanceof Error ? error.message : error),
    };
  }
};
await step('signUp', () => signUp(email, password, displayName));
await step('signInWrong', () => signIn(email, wrongPassword));
await step('signIn', () => signIn(email, password));
await step('profile', () => getMyProfile());
console.log('${DRIVER_MARKER}' + JSON.stringify(out));
process.exit(0);
`;

interface DriverStep {
  userId?: unknown;
  displayName?: unknown;
  plan?: unknown;
  error?: unknown;
  threw?: unknown;
}

const scorer: LocalStackScorer = async (ctx) => {
  const checks: CheckResult[] = [];
  try {
    // Unique suffix keeps signup emails collision-free across attempts.
    const suffix = Date.now().toString(36);
    const email = `alex-${suffix}@example.com`;
    const password = 'correct-horse-battery';
    const wrongPassword = 'wrong-horse-battery';
    const displayName = 'Alex Doe';

    const status = await readStatus(ctx);
    const apiUrl = str(status.API_URL);
    const publishableKey = str(status.PUBLISHABLE_KEY);
    if (!apiUrl || !publishableKey) {
      return fail(
        'read stack config from `supabase status`',
        `missing API_URL/PUBLISHABLE_KEY — is the stack running on a new-enough CLI? got keys: ${Object.keys(status).join(', ')}`
      );
    }

    // Be generous about a missing install step; the eval is about auth,
    // not npm. A no-op when the agent already installed dependencies.
    const install = await ctx.exec(
      `cd ${APP_DIR} && npm install --no-audit --no-fund --silent`,
      { timeoutMs: 180_000 }
    );
    if (!install.ok) {
      return fail(
        'installed app dependencies',
        install.stderr.trim() || install.stdout.trim()
      );
    }

    const written = await writeDriver(ctx);
    if (!written.ok) {
      return fail(
        'installed the eval driver',
        written.stderr.trim() || written.stdout.trim()
      );
    }
    const run = await ctx.exec(
      `cd ${APP_DIR} && SUPABASE_URL="${apiUrl}" SUPABASE_PUBLISHABLE_KEY="${publishableKey}" ` +
        `node ${DRIVER} "${email}" "${password}" "${displayName}" "${wrongPassword}"`,
      { timeoutMs: 60_000 }
    );
    const out = parseDriverOutput(run.stdout);
    checks.push({
      name: 'auth module loads and the driver completes',
      passed: out !== undefined,
      notes: out
        ? 'driver produced a result'
        : `no driver output — ${preview(run.stderr || run.stdout)}`,
    });

    const signUp = (out?.signUp ?? {}) as DriverStep;
    const signInWrong = (out?.signInWrong ?? {}) as DriverStep;
    const signIn = (out?.signIn ?? {}) as DriverStep;
    const profile = (out?.profile ?? {}) as DriverStep;

    // Ground truth from the database (superuser query bypasses RLS).
    const { rows: userRows } = await ctx.query(
      `select u.id::text as id, p.display_name, p.plan
         from auth.users u
         left join public.profiles p on p.id = u.id
        where u.email = '${email}'`
    );
    const dbUser = userRows[0];

    checks.push({
      name: 'signUp creates the account and returns its user id',
      passed: !!dbUser && !!signUp.userId && signUp.userId === dbUser.id,
      notes: dbUser
        ? `db user ${dbUser.id}, signUp returned ${JSON.stringify(signUp)}`
        : 'no auth.users row for the signup email',
    });

    // The seeded trigger falls back to the email local part, so the real
    // display name only arrives if signUp sent it as user metadata.
    checks.push({
      name: 'signup metadata reaches the profile (display name)',
      passed: dbUser?.display_name === displayName,
      notes: `profiles.display_name = ${JSON.stringify(dbUser?.display_name ?? null)}`,
    });

    checks.push({
      name: 'wrong password is rejected gracefully (no throw, no session)',
      passed: !!signInWrong.error && !signInWrong.userId && !signInWrong.threw,
      notes: JSON.stringify(signInWrong),
    });

    checks.push({
      name: 'signIn with the right password returns the user id',
      passed: !!dbUser && signIn.userId === dbUser.id,
      notes: JSON.stringify(signIn),
    });

    checks.push({
      name: "getMyProfile returns the signed-in user's profile",
      passed: profile.displayName === displayName && profile.plan === 'free',
      notes: JSON.stringify(profile),
    });

    // Client-side code: RLS + the publishable key are enough; the secret /
    // service-role key must not appear anywhere in the app.
    const secretScan = await ctx.exec(
      `grep -rlE --exclude-dir=node_modules 'sb_secret_|SERVICE_ROLE' ${APP_DIR} || true`
    );
    checks.push({
      name: 'app code does not use the secret / service-role key',
      passed: secretScan.stdout.trim() === '',
      notes: secretScan.stdout.trim() || 'no secret-key references found',
    });

    // GATING: the auth layer must be built on supabase-js, even though the
    // prompt never names it.
    checks.push(await sdkUsageCheck(ctx));

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    checks.push({
      name: 'scorer completed without errors',
      passed: false,
      notes: msg,
    });
    return { passed: false, checks };
  }
};

export default scorer;

function writeDriver(ctx: LocalStackEvalContext) {
  const encoded = Buffer.from(DRIVER_SOURCE, 'utf-8').toString('base64');
  return ctx.exec(`echo ${encoded} | base64 -d > ${APP_DIR}/${DRIVER}`);
}

function parseDriverOutput(
  stdout: string
): Record<string, unknown> | undefined {
  const line = stdout
    .split('\n')
    .find((candidate) => candidate.includes(DRIVER_MARKER));
  if (!line) return undefined;
  try {
    return JSON.parse(
      line.slice(line.indexOf(DRIVER_MARKER) + DRIVER_MARKER.length)
    );
  } catch {
    return undefined;
  }
}

/**
 * GATING: some app code file must genuinely import @supabase/supabase-js —
 * the specifier must be closed by a matching quote (so `-not-real` doesn't
 * match) and sit on a `from`/`require(`/`import(` line that isn't commented
 * out. Multi-line named imports still match: the closing `} from '…'` line
 * always carries `from` alongside the specifier.
 */
async function sdkUsageCheck(ctx: LocalStackEvalContext): Promise<CheckResult> {
  const NAME = 'implementation uses @supabase/supabase-js';
  const scan = await ctx.exec(
    `grep -rnE --exclude-dir=node_modules --include='*.mjs' --include='*.js' --include='*.cjs' --include='*.ts' ` +
      `"(from|require\\(|import\\()\\s*['\\"](npm:)?@supabase/supabase-js['\\"]" ${APP_DIR} ` +
      `| grep -vE ':[0-9]+:\\s*(//|\\*)' || true`
  );
  const files = [
    ...new Set(
      scan.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.slice(0, line.indexOf(':')))
    ),
  ];
  return {
    name: NAME,
    passed: files.length > 0,
    notes:
      files.length > 0
        ? `imports found in: ${files.join(', ')}`
        : 'no @supabase/supabase-js import found — this eval requires the SDK',
  };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function preview(body: string): string {
  return body.replace(/\s+/g, ' ').slice(0, 160);
}

function fail(
  name: string,
  notes: string
): { passed: false; checks: CheckResult[] } {
  return { passed: false, checks: [{ name, passed: false, notes }] };
}

/** Parse `supabase status -o json` for the stack's URL and keys. */
async function readStatus(
  ctx: LocalStackEvalContext
): Promise<Record<string, unknown>> {
  const res = await ctx.exec('supabase status -o json');
  const start = res.stdout.indexOf('{');
  const end = res.stdout.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error(
      `could not read \`supabase status\`: ${res.stderr || res.stdout}`
    );
  }
  return JSON.parse(res.stdout.slice(start, end + 1));
}
