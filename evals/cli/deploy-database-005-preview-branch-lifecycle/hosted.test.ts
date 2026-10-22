// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-database-005-preview-branch-lifecycle
import { describe, expect, it } from 'vitest';
import { REF } from './fakes.js';
import {
  checkHostedProject,
  hasHostedProject,
  NO_HOSTED_PROJECT,
} from './hosted.js';

const NAME = 'hosted project was provisioned for the run';

const FULL = {
  hostedRef: REF,
  hostedMgmt: { GET: async () => ({}) } as never,
  hostedQuery: async () => ({ rows: [] }),
};

const without = (key: keyof typeof FULL) => {
  const { [key]: _omitted, ...rest } = FULL;
  return rest;
};

describe('NO_HOSTED_PROJECT', () => {
  it('names the missing hosted project and what the eval needs', () => {
    expect(NO_HOSTED_PROJECT).toBe(
      'no hosted project on the scoring context: this eval needs `hostedProject: true` and a CLI experiment that links one'
    );
  });
});

describe('hasHostedProject', () => {
  it('is true only when the management client, the query function and the ref are all set', () => {
    expect(hasHostedProject(FULL)).toBe(true);
  });

  it.each(['hostedMgmt', 'hostedQuery', 'hostedRef'] as const)(
    'is false when %s is missing',
    (key) => {
      expect(hasHostedProject(without(key))).toBe(false);
    }
  );

  it('is false for a context with no hosted fields', () => {
    expect(hasHostedProject({})).toBe(false);
  });
});

describe('checkHostedProject', () => {
  it('passes with the project ref in the notes when everything is set', () => {
    expect(checkHostedProject(FULL)).toEqual({
      name: NAME,
      passed: true,
      notes: `hosted project ${REF}`,
    });
  });

  it.each(['hostedMgmt', 'hostedQuery', 'hostedRef'] as const)(
    'fails with NO_HOSTED_PROJECT when %s is missing',
    (key) => {
      expect(checkHostedProject(without(key))).toEqual({
        name: NAME,
        passed: false,
        notes: NO_HOSTED_PROJECT,
      });
    }
  );

  it('fails with NO_HOSTED_PROJECT for a context with no hosted fields', () => {
    expect(checkHostedProject({})).toEqual({
      name: NAME,
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
  });
});
