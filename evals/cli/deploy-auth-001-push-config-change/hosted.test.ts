// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-auth-001-push-config-change
import type { ManagementApiClient } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { NO_HOSTED_PROJECT } from '../lib/hosted.js';
import { mentionsNumber } from '../lib/report.js';
import {
  apiError,
  AUTH_CONFIG_PATH,
  authConfig,
  fakeMgmt,
  HOSTED_REF,
} from './fixtures.js';
import {
  checkProjectPasswordPolicy,
  HOSTED_CHECK_NAME,
  PROJECT_POLICY_CHECK_NAME,
  readProjectPasswordPolicy,
} from './hosted.js';

type HostedCtx = Parameters<typeof readProjectPasswordPolicy>[0];

const notesOf = (check: { notes?: string }) => check.notes ?? '';

describe('hosted constants', () => {
  it('keeps the check names stable for the results dashboard', () => {
    expect(HOSTED_CHECK_NAME).toBe('a hosted project is available to push to');
    expect(PROJECT_POLICY_CHECK_NAME).toBe(
      'the project requires passwords of at least 10 characters'
    );
  });
});

describe('readProjectPasswordPolicy', () => {
  it.each([10, null])(
    'reads password_min_length %s from the hosted project auth config',
    async (value) => {
      const { mgmt } = fakeMgmt(authConfig(value));

      expect(
        await readProjectPasswordPolicy({
          hostedRef: HOSTED_REF,
          hostedMgmt: mgmt,
        })
      ).toEqual({ ok: true, minPasswordLength: value });
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

  it.each<[name: string, ctxFor: (mgmt: ManagementApiClient) => HostedCtx]>([
    ['no hosted context', () => ({})],
    ['a client with no ref', (mgmt) => ({ hostedMgmt: mgmt })],
    ['a ref with no client', () => ({ hostedRef: HOSTED_REF })],
  ])(
    'reports no hosted project for %s without calling GET',
    async (_, ctxFor) => {
      const { GET, mgmt } = fakeMgmt(authConfig(10));

      expect(await readProjectPasswordPolicy(ctxFor(mgmt))).toEqual({
        ok: false,
        notes: NO_HOSTED_PROJECT,
      });
      expect(GET).not.toHaveBeenCalled();
    }
  );

  it('reports not ok with the status when the API answers 401', async () => {
    const { mgmt } = fakeMgmt(apiError(401, 'Unauthorized'));

    const policy = await readProjectPasswordPolicy({
      hostedRef: HOSTED_REF,
      hostedMgmt: mgmt,
    });

    expect(policy.ok).toBe(false);
    if (policy.ok) return;
    expect(policy.notes).toContain('401');
  });

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
});
