// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/lib
import type { ManagementApiClient } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  checkHostedProject,
  NO_HOSTED_PROJECT,
  readHostedFacts,
} from './hosted.js';

const REF = 'abcdefghijklmnopqrst';
const MGMT = {} as ManagementApiClient;
const NAME = 'a hosted project is available to push to';

describe('readHostedFacts', () => {
  it('returns the hosted ref when both the ref and the management client are set', () => {
    expect(readHostedFacts({ hostedRef: REF, hostedMgmt: MGMT })).toEqual({
      ok: true,
      ref: REF,
    });
  });

  it.each([
    ['the ref is missing', { hostedMgmt: MGMT }],
    ['the management client is missing', { hostedRef: REF }],
    ['both are missing', {}],
    ['the ref is empty', { hostedRef: '', hostedMgmt: MGMT }],
  ] as const)('reports no hosted project when %s', (_, ctx) => {
    expect(readHostedFacts(ctx)).toEqual({
      ok: false,
      notes: NO_HOSTED_PROJECT,
    });
  });

  it('points the no-hosted-project note at CLI-2754', () => {
    expect(NO_HOSTED_PROJECT).toContain('CLI-2754');
  });
});

describe('checkHostedProject', () => {
  it('passes under the given name when a hosted project is available', () => {
    expect(checkHostedProject({ ok: true, ref: REF }, NAME)).toEqual({
      name: NAME,
      passed: true,
    });
  });

  it('fails under the given name with the reason from the hosted facts', () => {
    expect(
      checkHostedProject(
        { ok: false, notes: 'platform-lite did not start' },
        NAME
      )
    ).toEqual({
      name: NAME,
      passed: false,
      notes: 'platform-lite did not start',
    });
  });

  it('fails and names CLI-2754 when the run has no hosted project', () => {
    const check = checkHostedProject(readHostedFacts({}), NAME);

    expect(check.passed).toBe(false);
    expect(check.notes).toContain('CLI-2754');
  });
});
