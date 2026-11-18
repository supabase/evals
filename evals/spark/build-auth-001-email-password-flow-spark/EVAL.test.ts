import { describe, expect, it } from 'vitest';
import {
  failedChecks,
  sparkScorer,
  stubSandbox,
} from '../../../experiments/spark/lib/runtime-stub.js';
import scorer from './EVAL.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

// What the SQL endpoint returns for the scorer's ground-truth query: the new
// auth user joined to its profile.
const dbRow = { id: USER_ID, display_name: 'Alex Doe', plan: 'free' };

interface AuthModule {
  /** The import line; defaults to a real supabase-js import. */
  sdkImport?: string;
  /** Extra top-level source, e.g. a comment mentioning a key. */
  extra?: string;
  /** Replacement bodies for the exported functions. */
  signUp?: string;
  signInWrong?: string;
  getMyProfile?: string;
}

/**
 * An auth module that uses the SDK client (the stub). It exits early without
 * the project URL and publishable key, or when it is handed a secret key, so
 * a passing run also proves the scorer sets exactly those.
 */
const authModule = (options: AuthModule = {}) => `// Auth layer
${options.sdkImport ?? "import { createClient } from '@supabase/supabase-js';"}
if (!process.env.SPARK_PROJECT_URL || !process.env.SPARK_PUBLISHABLE_KEY) process.exit(2);
if (process.env['SPARK_SECRET' + '_KEY']) process.exit(3);
${options.extra ?? ''}
export async function signUp(email, password, displayName) {
  ${options.signUp ?? `return { userId: '${USER_ID}' };`}
}
export async function signIn(email, password) {
  if (password !== 'correct-horse-battery') {
    ${options.signInWrong ?? `return { error: 'Invalid login credentials' };`}
  }
  return { userId: '${USER_ID}' };
}
export async function getMyProfile() {
  ${options.getMyProfile ?? `return { displayName: 'Alex Doe', plan: 'free' };`}
}
`;

async function score(
  options: { module?: string; rows?: Record<string, unknown>[] } = {}
) {
  const { rows = [dbRow] } = options;
  return failedChecks(
    await sparkScorer(
      scorer,
      (url) =>
        url.pathname === '/database/query'
          ? Response.json(rows)
          : Response.json([]),
      {
        sandbox: stubSandbox({
          'app/src/auth.mjs': options.module ?? authModule(),
        }),
      }
    )
  );
}

describe('email + password flow scorer', () => {
  it('passes every check for an SDK auth module that creates the profile', async () => {
    expect(await score()).toEqual([]);
  });

  it('fails the check of each broken behaviour', async () => {
    const profileName = 'signUp creates the profile with the display name';
    // The profile was never created (left join), or has the wrong name.
    for (const row of [
      { ...dbRow, display_name: null, plan: null },
      { ...dbRow, display_name: 'alex' },
    ])
      expect(await score({ rows: [row] })).toEqual([profileName]);

    expect(
      await score({
        module: authModule({ signUp: `return { userId: 'nope' };` }),
      })
    ).toEqual(['signUp creates the account and returns its user id']);

    const wrongPassword =
      'wrong password is rejected gracefully (no throw, no session)';
    for (const signInWrong of [
      `throw new Error('Invalid login credentials');`,
      `return { userId: '${USER_ID}' };`,
    ])
      expect(await score({ module: authModule({ signInWrong }) })).toEqual([
        wrongPassword,
      ]);

    for (const getMyProfile of [
      `return { displayName: 'alex', plan: 'free' };`,
      `return { displayName: 'Alex Doe', plan: 'pro' };`,
      `return { error: 'not signed in' };`,
    ])
      expect(await score({ module: authModule({ getMyProfile }) })).toEqual([
        "getMyProfile returns the signed-in user's profile",
      ]);
  });

  it('fails the secret-key check when app code references the secret key', async () => {
    const name = 'app code does not use the secret / service-role key';
    for (const extra of [
      `const key = 'sb_secret_abc';`,
      `const key = process.env.SPARK_SECRET_KEY;`,
      `// do not use SUPABASE_SERVICE_ROLE_KEY here`,
    ])
      expect(await score({ module: authModule({ extra }) })).toEqual([name]);
  });

  it('requires a real @supabase/supabase-js import', async () => {
    const name = 'implementation uses @supabase/supabase-js';
    for (const sdkImport of [
      // No SDK at all, commented out, or a different package with the same prefix.
      `const client = {};`,
      `// import { createClient } from '@supabase/supabase-js';`,
      `import { createClient } from '@supabase/supabase-js-not-real';`,
    ])
      expect(await score({ module: authModule({ sdkImport }) })).toContain(
        name
      );
    expect(
      await score({
        module: authModule({
          sdkImport: `const { createClient } = await import('@supabase/supabase-js');`,
        }),
      })
    ).toEqual([]);
  });

  it('fails when the module does not load or the driver produces no output', async () => {
    const failing = [
      'auth module loads and the driver completes',
      'signUp creates the account and returns its user id',
      'wrong password is rejected gracefully (no throw, no session)',
      'signIn with the right password returns the user id',
      "getMyProfile returns the signed-in user's profile",
    ];
    for (const module of [
      // The stub the agent never implemented, throwing at load time.
      `import { createClient } from '@supabase/supabase-js';\nthrow new Error('TODO: implement auth');\n`,
      `import { createClient } from '@supabase/supabase-js';\nprocess.exit(1);\n`,
    ])
      expect(await score({ module })).toEqual(failing);
  });
});
