// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-cli-002-use-project-api-keys
import type { ManagementApiClient } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  ANON_KEY,
  fakeMgmt,
  HOSTED_ABSENT,
  HOSTED_OK,
  HOSTED_REF,
  hostedContext,
  LEGACY_KEY_ROWS,
  NEW_KEY_ROWS,
  PUBLISHABLE_KEY,
  SECRET_KEY,
  SERVICE_ROLE_KEY,
  expectNoKeyValues,
} from './fixtures.js';
import {
  checkHostedProject,
  classifyApiKey,
  HOSTED_CHECK_NAME,
  readHostedFacts,
} from './hosted.js';

const API_KEYS_PATH = '/v1/projects/{ref}/api-keys';
const UNREADABLE = "could not read the project's API keys";

const sorted = (values: readonly string[] | undefined) =>
  [...(values ?? [])].sort();

describe('classifyApiKey', () => {
  it.each([
    ['a publishable key', { name: 'default', type: 'publishable' }, 'client'],
    [
      'a publishable key with another name',
      { name: 'web', type: 'publishable' },
      'client',
    ],
    ['the legacy anon key', { name: 'anon', type: 'legacy' }, 'client'],
    ['a secret key', { name: 'default', type: 'secret' }, 'secret'],
    [
      'a secret key with another name',
      { name: 'ci_deploy', type: 'secret' },
      'secret',
    ],
    [
      'the legacy service_role key',
      { name: 'service_role', type: 'legacy' },
      'secret',
    ],
    [
      'a legacy key with an unrecognised name',
      { name: 'mystery', type: 'legacy' },
      'unknown',
    ],
    [
      'a key with no type and an unrecognised name',
      { name: 'mystery' },
      'unknown',
    ],
    ['a key with null name and type', { name: null, type: null }, 'unknown'],
    ['an empty descriptor', {}, 'unknown'],
  ] as const)('classifies %s as %s', (_, key, expected) => {
    expect(classifyApiKey(key)).toBe(expected);
  });
});

describe('readHostedFacts', () => {
  it('returns the legacy anon key as a client key and the service_role key as a secret key', async () => {
    const { hostedRef, hostedMgmt } = hostedContext(LEGACY_KEY_ROWS);

    expect(await readHostedFacts({ hostedRef, hostedMgmt })).toEqual({
      ok: true,
      ref: HOSTED_REF,
      clientKeys: [ANON_KEY],
      secretKeys: [SERVICE_ROLE_KEY],
    });
  });

  it('accepts a project that only has the new publishable and secret keys', async () => {
    const { hostedRef, hostedMgmt } = hostedContext(NEW_KEY_ROWS);

    expect(await readHostedFacts({ hostedRef, hostedMgmt })).toEqual({
      ok: true,
      ref: HOSTED_REF,
      clientKeys: [PUBLISHABLE_KEY],
      secretKeys: [SECRET_KEY],
    });
  });

  it('returns every client key and every secret key when the project has both generations', async () => {
    const { hostedRef, hostedMgmt } = hostedContext([
      ...LEGACY_KEY_ROWS,
      ...NEW_KEY_ROWS,
    ]);

    const facts = await readHostedFacts({ hostedRef, hostedMgmt });

    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    expect(sorted(facts.clientKeys)).toEqual(
      sorted([ANON_KEY, PUBLISHABLE_KEY])
    );
    expect(sorted(facts.secretKeys)).toEqual(
      sorted([SERVICE_ROLE_KEY, SECRET_KEY])
    );
  });

  it('asks the api-keys endpoint once, for the hosted ref, with reveal=true', async () => {
    const { hostedRef, hostedMgmt, GET } = hostedContext();

    await readHostedFacts({ hostedRef, hostedMgmt });

    expect(GET).toHaveBeenCalledTimes(1);
    expect(GET).toHaveBeenCalledWith(
      API_KEYS_PATH,
      expect.objectContaining({
        params: { path: { ref: HOSTED_REF }, query: { reveal: true } },
      })
    );
  });

  it('drops keys whose api_key is null, empty or absent', async () => {
    const { hostedRef, hostedMgmt } = hostedContext([
      { name: 'anon', api_key: null, type: 'legacy' },
      { name: 'service_role', api_key: '', type: 'legacy' },
      { name: 'default', type: 'secret' },
      { name: 'default', api_key: PUBLISHABLE_KEY, type: 'publishable' },
    ]);

    expect(await readHostedFacts({ hostedRef, hostedMgmt })).toEqual({
      ok: true,
      ref: HOSTED_REF,
      clientKeys: [PUBLISHABLE_KEY],
      secretKeys: [],
    });
  });

  it('puts a key of unrecognised kind in neither list', async () => {
    const unknownKey = 'evals-fixture-unknown-kind-do-not-use';
    const { hostedRef, hostedMgmt } = hostedContext([
      ...LEGACY_KEY_ROWS,
      { name: 'mystery', api_key: unknownKey, type: 'legacy' },
    ]);

    const facts = await readHostedFacts({ hostedRef, hostedMgmt });

    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    expect(facts.clientKeys).not.toContain(unknownKey);
    expect(facts.secretKeys).not.toContain(unknownKey);
  });

  it.each([
    [
      'the ref is missing',
      (mgmt: ManagementApiClient) => ({ hostedMgmt: mgmt }),
    ],
    [
      'the management client is missing',
      (_: ManagementApiClient) => ({ hostedRef: HOSTED_REF }),
    ],
    ['both are missing', (_: ManagementApiClient) => ({})],
    [
      'the ref is empty',
      (mgmt: ManagementApiClient) => ({ hostedRef: '', hostedMgmt: mgmt }),
    ],
  ])(
    'reports no hosted project, naming CLI-2754, when %s',
    async (_, build) => {
      const { mgmt, GET } = fakeMgmt({ data: LEGACY_KEY_ROWS });

      const facts = await readHostedFacts(build(mgmt));

      expect(facts.ok).toBe(false);
      if (facts.ok) return;
      expect(facts.notes).toContain('CLI-2754');
      expect(GET).not.toHaveBeenCalled();
    }
  );

  it('fails with the unreadable-keys note when the API answers with an error', async () => {
    const { mgmt } = fakeMgmt({ error: { message: 'boom' }, status: 500 });

    const facts = await readHostedFacts({
      hostedRef: HOSTED_REF,
      hostedMgmt: mgmt,
    });

    expect(facts.ok).toBe(false);
    if (facts.ok) return;
    expect(facts.notes).toContain(UNREADABLE);
  });

  it('fails with the unreadable-keys note, carrying the message, when the call throws', async () => {
    const { mgmt } = fakeMgmt(new Error('connect ECONNREFUSED'));

    const facts = await readHostedFacts({
      hostedRef: HOSTED_REF,
      hostedMgmt: mgmt,
    });

    expect(facts.ok).toBe(false);
    if (facts.ok) return;
    expect(facts.notes).toContain(UNREADABLE);
    expect(facts.notes).toContain('connect ECONNREFUSED');
  });

  it.each([
    ['no data and no error', { data: undefined }],
    ['an empty key list', { data: [] }],
    ['only secret keys', { data: [LEGACY_KEY_ROWS[1], NEW_KEY_ROWS[1]] }],
    [
      'a masked anon key and a visible service_role key',
      {
        data: [
          { name: 'anon', api_key: null, type: 'legacy' },
          LEGACY_KEY_ROWS[1],
        ],
      },
    ],
  ] as const)(
    'fails when the API returns %s, since there is no client key to compare',
    async (_, response) => {
      const { mgmt } = fakeMgmt(response as never);

      const facts = await readHostedFacts({
        hostedRef: HOSTED_REF,
        hostedMgmt: mgmt,
      });

      expect(facts.ok).toBe(false);
      if (facts.ok) return;
      expect(facts.notes).toContain(UNREADABLE);
      expectNoKeyValues(facts.notes);
    }
  );
});

describe('checkHostedProject', () => {
  it('passes when a hosted project with keys is available', () => {
    expect(checkHostedProject(HOSTED_OK)).toMatchObject({
      name: 'a hosted project is available',
      passed: true,
    });
  });

  it('exposes the check name it reports under', () => {
    expect(HOSTED_CHECK_NAME).toBe('a hosted project is available');
  });

  it('fails and names CLI-2754 when the run has no hosted project', () => {
    const check = checkHostedProject(HOSTED_ABSENT);

    expect(check).toMatchObject({ name: HOSTED_CHECK_NAME, passed: false });
    expect(check.notes).toContain('CLI-2754');
  });

  it('carries the reason from the hosted facts into the notes', () => {
    const check = checkHostedProject({
      ok: false,
      notes: `${UNREADABLE} (status 500)`,
    });

    expect(check.passed).toBe(false);
    expect(check.notes).toContain('status 500');
  });
});
