import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
} from '@supabase-evals/core';
import type { SparkScoringContext } from '../../../experiments/spark/lib/runtime.js';

// Spark port of the benchmark build-auth-001 scenario: the prompt asks the
// agent to finish the app's auth layer (app/src/auth.mjs) against the provided
// Spark project and never names supabase-js — the "uses @supabase/supabase-js"
// check is GATING. On top of SDK discovery it measures driving auth correctly:
// handling bad credentials gracefully and reading the RLS-scoped profile with
// the session actually attached.
//
// The one deliberate deviation from the original: Spark cannot run the
// profiles trigger on auth.users, so the app must create the profile row
// itself after signUp (the seeded schema has an insert policy for that).
// Everything else — table, RLS and policies — is the original schema.

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

const scorer: ToolScorer = async (ctx) => {
  const checks: CheckResult[] = [];
  try {
    const { sandbox } = ctx;
    if (!sandbox)
      return fail(
        'agent sandbox available',
        'the scorer runs the auth module in the agent sandbox, but this run had none'
      );
    const { project } = ctx as unknown as SparkScoringContext;

    // Unique suffix keeps signup emails collision-free across attempts.
    const suffix = Date.now().toString(36);
    const email = `alex-${suffix}@example.com`;
    const password = 'correct-horse-battery';
    const wrongPassword = 'wrong-horse-battery';
    const displayName = 'Alex Doe';

    // Be generous about a missing install step; the eval is about auth,
    // not npm. A no-op when the agent already installed dependencies.
    const install = await sandbox.exec(
      `cd ${APP_DIR} && npm install --no-audit --no-fund --silent`,
      { timeoutMs: 180_000 }
    );
    if (!install.ok) {
      return fail(
        'installed app dependencies',
        install.stderr.trim() || install.stdout.trim()
      );
    }

    const written = await writeDriver(sandbox);
    if (!written.ok) {
      return fail(
        'installed the eval driver',
        written.stderr.trim() || written.stdout.trim()
      );
    }
    // Client-side code: only the publishable key is handed to the app.
    const run = await sandbox.exec(
      `cd ${APP_DIR} && node ${DRIVER} "${email}" "${password}" "${displayName}" "${wrongPassword}"`,
      {
        timeoutMs: 60_000,
        env: {
          SPARK_PROJECT_URL: project.projectUrl,
          SPARK_PUBLISHABLE_KEY: project.publishableKey,
        },
      }
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

    // Ground truth from the database (the SQL endpoint bypasses RLS).
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

    // Spark has no signup trigger, so the profile (and its display name) only
    // exists if the app inserted it after signUp.
    checks.push({
      name: 'signUp creates the profile with the display name',
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
    // service-role key must not appear anywhere in the app — by name or by
    // value. The literal key is matched with -F and never echoed in notes.
    const secretScan = await sandbox.exec(
      `{ grep -rlE --exclude-dir=node_modules 'sb_secret_|SERVICE_ROLE|SPARK_SECRET_KEY' ${APP_DIR}; ` +
        (project.secretKey
          ? `grep -rlF --exclude-dir=node_modules -e '${project.secretKey}' ${APP_DIR}; `
          : '') +
        '} | sort -u || true'
    );
    checks.push({
      name: 'app code does not use the secret / service-role key',
      passed: secretScan.stdout.trim() === '',
      notes:
        secretScan.stdout.trim().replace(/\s+/g, ', ') ||
        'no secret-key references found',
    });

    // GATING: the auth layer must be built on supabase-js, even though the
    // prompt never names it.
    checks.push(await sdkUsageCheck(sandbox));

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

function writeDriver(sandbox: NonNullable<ToolEvalContext['sandbox']>) {
  const encoded = Buffer.from(DRIVER_SOURCE, 'utf-8').toString('base64');
  return sandbox.exec(`echo ${encoded} | base64 -d > ${APP_DIR}/${DRIVER}`);
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
async function sdkUsageCheck(
  sandbox: NonNullable<ToolEvalContext['sandbox']>
): Promise<CheckResult> {
  const NAME = 'implementation uses @supabase/supabase-js';
  const scan = await sandbox.exec(
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

function preview(body: string): string {
  return body.replace(/\s+/g, ' ').slice(0, 160);
}

function fail(
  name: string,
  notes: string
): { passed: false; checks: CheckResult[] } {
  return { passed: false, checks: [{ name, passed: false, notes }] };
}
