// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-cli-001-login-and-link
import type { ManagementApiClient } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { HOSTED_OK, HOSTED_REF } from './fixtures.js';
import {
  checkHostedProject,
  HOSTED_CHECK_NAME,
  readHostedFacts,
} from './hosted.js';

const MGMT = {} as ManagementApiClient;

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
  ] as const)('reports no hosted project when %s', (_, ctx) => {
    const facts = readHostedFacts(ctx);

    expect(facts.ok).toBe(false);
    if (facts.ok) return;
    expect(facts.notes).toContain('CLI-2754');
    expect(facts.notes).toContain(
      'no hosted project in CI until the staging org lands'
    );
  });

  it('treats an empty ref as no hosted project', () => {
    const facts = readHostedFacts({ hostedRef: '', hostedMgmt: MGMT });

    expect(facts.ok).toBe(false);
  });
});

describe('checkHostedProject', () => {
  it('passes when a hosted project is available', () => {
    expect(checkHostedProject(HOSTED_OK)).toMatchObject({
      name: 'a hosted project is available to link',
      passed: true,
    });
  });

  it('fails and names CLI-2754 when the run has no hosted project', () => {
    const check = checkHostedProject(readHostedFacts({}));

    expect(check).toMatchObject({ name: HOSTED_CHECK_NAME, passed: false });
    expect(check.notes).toContain('CLI-2754');
    expect(check.notes).toContain(
      'no hosted project in CI until the staging org lands'
    );
  });

  it('carries the reason from the hosted facts into the notes', () => {
    const check = checkHostedProject({
      ok: false,
      notes: 'platform-lite did not start',
    });

    expect(check.passed).toBe(false);
    expect(check.notes).toContain('platform-lite did not start');
  });
});
