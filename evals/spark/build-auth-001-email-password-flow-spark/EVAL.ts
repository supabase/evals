import { AuthApiError, createClient } from '@supabase/supabase-js';
import type { CheckResult, ToolScorer } from '@supabase-evals/core';
import { findLeakedCredentials } from '../../../experiments/spark/lib/scoring.js';
import type { SparkScoringContext } from '../../../experiments/spark/lib/runtime.js';

// Spark port of the benchmark build-auth-001 scenario. The original relied on a
// signup trigger and RLS; Spark supports neither yet, so the agent creates the
// profile itself and isolation is not scored.

const EMAIL = 'alex@example.com';
const PASSWORD = 'correct-horse-battery';
const DISPLAY_NAME = 'Alex Doe';

const scorer: ToolScorer = async (ctx) => {
  const context = ctx as unknown as SparkScoringContext;
  const { projectUrl, publishableKey } = context.project;
  const anonClient = () =>
    createClient(projectUrl, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  const alex = anonClient();
  const checks: CheckResult[] = [];

  const signIn = await alex.auth.signInWithPassword({
    email: EMAIL,
    password: PASSWORD,
  });
  const userId = signIn.data.user?.id;
  checks.push({
    name: 'Alex can sign in with the right password',
    passed: !signIn.error && !!userId,
    notes: signIn.error?.message,
  });

  const wrong = await anonClient().auth.signInWithPassword({
    email: EMAIL,
    password: 'wrong-horse-battery',
  });
  checks.push({
    name: 'Wrong password is rejected without a session',
    passed:
      wrong.error instanceof AuthApiError &&
      wrong.error.status === 400 &&
      !wrong.data.session,
    notes: wrong.error?.message,
  });

  if (userId) {
    const { data, error } = await alex
      .from('profiles')
      .select('*')
      .eq('id', userId);
    checks.push({
      name: "Alex's profile has the display name and default plan",
      passed:
        data?.length === 1 &&
        data[0].display_name === DISPLAY_NAME &&
        data[0].plan === 'free',
      notes: error?.message ?? JSON.stringify(data),
    });
  } else {
    checks.push({
      name: "Alex's profile has the display name and default plan",
      passed: false,
      notes: 'no signed-in user to look up',
    });
  }

  const leaks = findLeakedCredentials(context.project, ctx);
  checks.push({
    name: 'Keys and tokens stay out of the agent output',
    passed: leaks.length === 0,
    notes: leaks.length ? `found: ${leaks.join(', ')}` : undefined,
  });

  const report = await ctx.judge({
    input: ctx.agentReport ?? '',
    rubric:
      'The response greets Alex Doe using data read from their profile: the display name "Alex Doe" and the plan "free". It reports that the account was created and that signing back in worked. It must not reveal a secret key or an access token.',
  });
  checks.push({ name: 'Agent greets Alex from their profile', ...report });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
