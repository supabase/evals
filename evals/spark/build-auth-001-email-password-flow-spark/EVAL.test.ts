import { describe, expect, it, vi } from 'vitest';
import {
  SPARK_TEST_KEYS,
  failedChecks,
  sparkScorer,
} from '../../../experiments/spark/lib/runtime-stub.js';
import scorer from './EVAL.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

const profile = {
  id: USER_ID,
  display_name: 'Alex Doe',
  plan: 'free',
  created_at: '2026-11-06 12:00:00',
};

function score(
  options: {
    accountExists?: boolean;
    acceptsAnyPassword?: boolean;
    profiles?: unknown[];
    agentReport?: string;
    transcript?: Parameters<typeof scorer>[0]['transcript'];
    reportPasses?: boolean;
  } = {}
) {
  const { accountExists = true, acceptsAnyPassword = false } = options;
  return sparkScorer(
    scorer,
    async (url, init, request) => {
      if (url.pathname === '/auth/v1/token') {
        const body = JSON.parse(String(init?.body ?? (await request?.text())));
        return accountExists &&
          (acceptsAnyPassword || body.password === 'correct-horse-battery')
          ? Response.json({
              access_token: 'access',
              token_type: 'bearer',
              expires_in: 3600,
              refresh_token: 'refresh',
              user: { id: USER_ID, email: 'alex@example.com' },
            })
          : Response.json(
              { error: 'invalid_grant', msg: 'Invalid login credentials' },
              { status: 400 }
            );
      }
      expect(url.pathname).toBe('/rest/v1/profiles');
      return Response.json(options.profiles ?? [profile]);
    },
    {
      transcript: options.transcript,
      agentReport: options.agentReport ?? 'Hello, Alex Doe! Your plan is free.',
      judge: vi.fn(async () => ({ passed: options.reportPasses ?? true })),
    }
  );
}

describe('account and profile checks', () => {
  it('accepts a signed-up Alex with a correct profile', async () => {
    const result = await score();
    expect(failedChecks(result)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('fails every account-dependent check when Alex was never created', async () => {
    const result = await score({ accountExists: false });
    expect(failedChecks(result)).toEqual([
      'Alex can sign in with the right password',
      "Alex's profile has the display name and default plan",
    ]);
  });

  it('rejects a project that accepts a wrong password', async () => {
    expect(failedChecks(await score({ acceptsAnyPassword: true }))).toEqual([
      'Wrong password is rejected without a session',
    ]);
  });

  it('rejects a missing, wrong or duplicated profile', async () => {
    for (const profiles of [
      [],
      [{ ...profile, display_name: 'alex' }],
      [{ ...profile, plan: 'pro' }],
      [profile, { ...profile, created_at: '2026-11-06 12:01:00' }],
    ])
      expect(failedChecks(await score({ profiles }))).toEqual([
        "Alex's profile has the display name and default plan",
      ]);
  });

  it('fails when the report does not greet Alex from the profile', async () => {
    expect(failedChecks(await score({ reportPasses: false }))).toEqual([
      'Agent greets Alex from their profile',
    ]);
  });
});

describe('key leak check', () => {
  it('fails when the project key shows up in the agent output', async () => {
    expect(
      failedChecks(
        await score({ agentReport: `Done. I used ${SPARK_TEST_KEYS.secret}.` })
      )
    ).toEqual(['Keys and tokens stay out of the agent output']);
  });

  it('ignores keys in the scripts the agent wrote', async () => {
    const result = await score({
      transcript: [
        {
          type: 'tool_call',
          name: 'shell',
          input: { command: `curl -H "apikey: ${SPARK_TEST_KEYS.secret}"` },
          output: 'ok',
        },
      ],
    });
    expect(failedChecks(result)).toEqual([]);
  });
});
