// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-auth-001-push-config-change
import type { ManagementApiClient } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { mentionsNumber } from '../lib/report.js';
import {
  apiError,
  AUTH_CONFIG_PATH,
  authConfig,
  fakeMgmt,
  HOSTED_OK,
  HOSTED_REF,
} from './fixtures.js';
import {
  checkHostedProject,
  checkProjectPasswordPolicy,
  HOSTED_CHECK_NAME,
  NO_HOSTED_PROJECT,
  PROJECT_POLICY_CHECK_NAME,
  readHostedFacts,
  readProjectPasswordPolicy,
} from './hosted.js';

const MGMT = {} as ManagementApiClient;

const notesOf = (check: { notes?: string }) => check.notes ?? '';

describe('hosted constants', () => {
  it('names the checks and points the no-hosted-project note at CLI-2754', () => {
    expect(HOSTED_CHECK_NAME).toBe('a hosted project is available to push to');
    expect(PROJECT_POLICY_CHECK_NAME).toBe(
      'the project requires passwords of at least 10 characters'
    );
    expect(NO_HOSTED_PROJECT).toContain('CLI-2754');
  });
});

describe('readHostedFacts', () => {
  it('returns the hosted ref when both the ref and the management client are set', () => {
    expect(
      readHostedFacts({ hostedRef: HOSTED_REF, hostedMgmt: MGMT })
    ).toEqual({ ok: true, ref: HOSTED_REF });
  });

  it.each([
    ['the ref is missing', { hostedMgmt: MGMT }],
    ['the management client is missing', { hostedRef: HOSTED_REF }],
    ['both are missing', {}],
    ['the ref is empty', { hostedRef: '', hostedMgmt: MGMT }],
  ] as const)('reports no hosted project when %s', (_, ctx) => {
    const facts = readHostedFacts(ctx);

    expect(facts.ok).toBe(false);
    if (facts.ok) return;
    expect(facts.notes).toContain('CLI-2754');
  });
});

describe('checkHostedProject', () => {
  it('passes when a hosted project is available', () => {
    expect(checkHostedProject(HOSTED_OK)).toMatchObject({
      name: HOSTED_CHECK_NAME,
      passed: true,
    });
  });

  it('fails and names CLI-2754 when the run has no hosted project', () => {
    const check = checkHostedProject(readHostedFacts({}));

    expect(check).toMatchObject({ name: HOSTED_CHECK_NAME, passed: false });
    expect(notesOf(check)).toContain('CLI-2754');
  });

  it('carries the reason from the hosted facts into the notes', () => {
    const check = checkHostedProject({
      ok: false,
      notes: 'platform-lite did not start',
    });

    expect(check.passed).toBe(false);
    expect(notesOf(check)).toContain('platform-lite did not start');
  });
});

describe('readProjectPasswordPolicy', () => {
  it.each([
    [10, 10],
    [6, 6],
    [8, 8],
    [null, null],
  ])(
    'reads password_min_length %s from the hosted project auth config',
    async (returned, expected) => {
      const { mgmt } = fakeMgmt(authConfig(returned));

      expect(
        await readProjectPasswordPolicy({
          hostedRef: HOSTED_REF,
          hostedMgmt: mgmt,
        })
      ).toEqual({ ok: true, minPasswordLength: expected });
    }
  );

  it('asks the Management API for the auth config of the hosted ref exactly once', async () => {
    const { GET, mgmt } = fakeMgmt(authConfig(10));

    await readProjectPasswordPolicy({
      hostedRef: HOSTED_REF,
      hostedMgmt: mgmt,
    });

    expect(GET).toHaveBeenCalledTimes(1);
    expect(GET).toHaveBeenCalledWith(AUTH_CONFIG_PATH, {
      params: { path: { ref: HOSTED_REF } },
    });
  });

  it('reports no hosted project when there is no hosted context', async () => {
    expect(await readProjectPasswordPolicy({})).toEqual({
      ok: false,
      notes: NO_HOSTED_PROJECT,
    });
  });

  it('never calls GET for a client that has no ref', async () => {
    const { GET, mgmt } = fakeMgmt(authConfig(10));

    expect(await readProjectPasswordPolicy({ hostedMgmt: mgmt })).toEqual({
      ok: false,
      notes: NO_HOSTED_PROJECT,
    });
    expect(GET).not.toHaveBeenCalled();
  });

  it('reports no hosted project for a ref that has no client', async () => {
    expect(await readProjectPasswordPolicy({ hostedRef: HOSTED_REF })).toEqual({
      ok: false,
      notes: NO_HOSTED_PROJECT,
    });
  });

  it.each([401, 403, 404, 500])(
    'reports not ok with the status when the API answers %i',
    async (status) => {
      const { mgmt } = fakeMgmt(apiError(status, 'Unauthorized'));

      const policy = await readProjectPasswordPolicy({
        hostedRef: HOSTED_REF,
        hostedMgmt: mgmt,
      });

      expect(policy.ok).toBe(false);
      if (policy.ok) return;
      expect(policy.notes).toContain(String(status));
    }
  );

  it('reports not ok rather than a value when the response has neither data nor error', async () => {
    const { mgmt } = fakeMgmt({
      data: undefined,
      error: undefined,
      response: { status: 200 },
    });

    const policy = await readProjectPasswordPolicy({
      hostedRef: HOSTED_REF,
      hostedMgmt: mgmt,
    });

    expect(policy.ok).toBe(false);
  });

  it.each([
    [
      'rejects',
      () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:54321')),
    ],
    [
      'throws synchronously',
      () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:54321');
      },
    ],
  ])(
    'reports not ok with the message instead of throwing when GET %s',
    async (_, respond) => {
      const { mgmt } = fakeMgmt(respond);

      const policy = await readProjectPasswordPolicy({
        hostedRef: HOSTED_REF,
        hostedMgmt: mgmt,
      });

      expect(policy.ok).toBe(false);
      if (policy.ok) return;
      expect(policy.notes).toContain('connect ECONNREFUSED 127.0.0.1:54321');
    }
  );
});

describe('checkProjectPasswordPolicy', () => {
  it('passes when the project requires 10', () => {
    expect(
      checkProjectPasswordPolicy({ ok: true, minPasswordLength: 10 })
    ).toMatchObject({ name: PROJECT_POLICY_CHECK_NAME, passed: true });
  });

  it.each([6, 8, 9, 11, 12])(
    'fails and names both the value and 10 when the project requires %i',
    (value) => {
      const check = checkProjectPasswordPolicy({
        ok: true,
        minPasswordLength: value,
      });

      expect(check).toMatchObject({
        name: PROJECT_POLICY_CHECK_NAME,
        passed: false,
      });
      expect(mentionsNumber(notesOf(check), value)).toBe(true);
      expect(mentionsNumber(notesOf(check), 10)).toBe(true);
    }
  );

  it('fails and says not set when the project has no minimum', () => {
    const check = checkProjectPasswordPolicy({
      ok: true,
      minPasswordLength: null,
    });

    expect(check).toMatchObject({
      name: PROJECT_POLICY_CHECK_NAME,
      passed: false,
    });
    expect(notesOf(check)).toContain('not set');
  });

  it('fails with the policy notes when the project could not be read', () => {
    expect(
      checkProjectPasswordPolicy({
        ok: false,
        notes: 'could not read the auth config: status 401',
      })
    ).toEqual({
      name: PROJECT_POLICY_CHECK_NAME,
      passed: false,
      notes: 'could not read the auth config: status 401',
    });
  });

  it('fails with the CLI-2754 note when the run has no hosted project', async () => {
    const check = checkProjectPasswordPolicy(
      await readProjectPasswordPolicy({})
    );

    expect(check.passed).toBe(false);
    expect(notesOf(check)).toContain('CLI-2754');
  });
});
