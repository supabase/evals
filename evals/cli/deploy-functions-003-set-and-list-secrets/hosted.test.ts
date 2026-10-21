// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-functions-003-set-and-list-secrets
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  checkHostedProject,
  checkProductionValues,
  describeSecrets,
  HOSTED_CHECK_NAME,
  hasHostedProject,
  NO_HOSTED_PROJECT,
  type ProjectSecret,
  readProjectSecrets,
  type SecretsProbe,
  secretStates,
  VALUES_CHECK_NAME,
} from './hosted.js';
import { DEVELOPMENT_VALUES, PRODUCTION_VALUES, SECRET_NAMES } from './seed.js';

const REF = 'abcdefghijklmnopqrst';
const SECRETS_PATH = '/v1/projects/{ref}/secrets';

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');

const PRODUCTION: ProjectSecret[] = SECRET_NAMES.map((name) => ({
  name,
  value: digest(PRODUCTION_VALUES[name]),
}));

const DEVELOPMENT: ProjectSecret[] = SECRET_NAMES.map((name) => ({
  name,
  value: digest(DEVELOPMENT_VALUES[name]),
}));

const withValue = (
  secrets: readonly ProjectSecret[],
  name: string,
  value: string
) => secrets.map((s) => (s.name === name ? { ...s, value } : s));

const without = (secrets: readonly ProjectSecret[], name: string) =>
  secrets.filter((s) => s.name !== name);

const probeOf = (secrets: ProjectSecret[]): SecretsProbe => ({
  ok: true,
  secrets,
});

const PRODUCTION_STATES = {
  RESEND_API_KEY: 'production',
  STRIPE_SECRET_KEY: 'production',
  STRIPE_WEBHOOK_SECRET: 'production',
} as const;

type GetResult = {
  data?: unknown;
  error?: unknown;
  response: { status: number };
};

function hostedCtx(get: (path: string, opts?: unknown) => Promise<GetResult>) {
  const GET = vi.fn(get);
  return {
    GET,
    ctx: { hostedRef: REF, hostedMgmt: { GET } as never },
  };
}

const listed = (secrets: ProjectSecret[]): GetResult => ({
  data: secrets.map((s) => ({ ...s, updated_at: '2026-01-01T00:00:00.000Z' })),
  error: undefined,
  response: { status: 200 },
});

const failed = (status: number, error: unknown): GetResult => ({
  data: undefined,
  error,
  response: { status },
});

const ALL_VALUES = [
  ...Object.values(PRODUCTION_VALUES),
  ...Object.values(DEVELOPMENT_VALUES),
];

describe('constants', () => {
  it('names the missing hosted project and what the eval needs', () => {
    expect(NO_HOSTED_PROJECT).toBe(
      'no hosted project on the scoring context: this eval needs `hostedProject: true` and a CLI experiment that links one'
    );
  });

  it('names the hosted and values checks', () => {
    expect(HOSTED_CHECK_NAME).toBe(
      'hosted project was provisioned for the run'
    );
    expect(VALUES_CHECK_NAME).toBe(
      'the project holds the production value of every function secret'
    );
  });
});

describe('hasHostedProject', () => {
  it('is true with both the Management API client and the ref', () => {
    expect(hasHostedProject(hostedCtx(async () => listed([])).ctx)).toBe(true);
  });

  it('is false with no hosted fields', () => {
    expect(hasHostedProject({})).toBe(false);
  });

  it('is false with a ref but no Management API client', () => {
    expect(hasHostedProject({ hostedRef: REF })).toBe(false);
  });

  it('is false with a Management API client but no ref', () => {
    const { ctx } = hostedCtx(async () => listed([]));
    expect(hasHostedProject({ hostedMgmt: ctx.hostedMgmt })).toBe(false);
  });
});

describe('checkHostedProject', () => {
  it('passes and names the ref when a hosted project is on the context', () => {
    expect(checkHostedProject(hostedCtx(async () => listed([])).ctx)).toEqual({
      name: HOSTED_CHECK_NAME,
      passed: true,
      notes: `hosted project ${REF}`,
    });
  });

  it('fails with NO_HOSTED_PROJECT when the context has none', () => {
    expect(checkHostedProject({})).toEqual({
      name: HOSTED_CHECK_NAME,
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
  });
});

describe('readProjectSecrets', () => {
  it('lists the project secrets from the Management API by ref', async () => {
    const { ctx, GET } = hostedCtx(async () => listed(PRODUCTION));
    await readProjectSecrets(ctx);
    expect(GET).toHaveBeenCalledTimes(1);
    expect(GET).toHaveBeenCalledWith(SECRETS_PATH, {
      params: { path: { ref: REF } },
    });
  });

  it('returns each secret name with the value the API gave', async () => {
    const { ctx } = hostedCtx(async () => listed(PRODUCTION));
    const probe = await readProjectSecrets(ctx);
    expect(probe.ok).toBe(true);
    expect(
      probe.ok && probe.secrets.map(({ name, value }) => ({ name, value }))
    ).toEqual(PRODUCTION);
  });

  it('returns an empty list for a project with no secrets', async () => {
    const { ctx } = hostedCtx(async () => listed([]));
    const probe = await readProjectSecrets(ctx);
    expect(probe.ok && probe.secrets).toEqual([]);
  });

  it.each([404, 500])(
    'fails with the status and the error body on a %i',
    async (status) => {
      const { ctx } = hostedCtx(async () =>
        failed(status, { message: 'upstream exploded' })
      );
      const probe = await readProjectSecrets(ctx);
      expect(probe.ok).toBe(false);
      expect(!probe.ok && probe.notes).toContain(
        `could not list the project's secrets: status ${status}`
      );
      expect(!probe.ok && probe.notes).toContain('upstream exploded');
    }
  );

  it('truncates a long error body in the notes', async () => {
    const { ctx } = hostedCtx(async () =>
      failed(500, { message: `${'noise '.repeat(1000)}TAIL-MARKER` })
    );
    const probe = await readProjectSecrets(ctx);
    expect(probe.ok).toBe(false);
    expect(!probe.ok && probe.notes.length).toBeLessThan(600);
    expect(!probe.ok && probe.notes).not.toContain('TAIL-MARKER');
  });

  it('fails with the error message when the client throws, and never rejects', async () => {
    const { ctx } = hostedCtx(async () => {
      throw new Error('connection reset');
    });
    const probe = await readProjectSecrets(ctx);
    expect(probe).toEqual({ ok: false, notes: 'connection reset' });
  });

  it('fails with a non-Error throw rendered as text', async () => {
    const { ctx } = hostedCtx(async () => {
      throw 'plain string failure';
    });
    expect(await readProjectSecrets(ctx)).toEqual({
      ok: false,
      notes: 'plain string failure',
    });
  });

  it('fails with NO_HOSTED_PROJECT and makes no call without a hosted project', async () => {
    const expected = { ok: false, notes: NO_HOSTED_PROJECT };
    expect(await readProjectSecrets({})).toEqual(expected);
    const { ctx, GET } = hostedCtx(async () => listed(PRODUCTION));
    expect(await readProjectSecrets({ ...ctx, hostedRef: undefined })).toEqual(
      expected
    );
    expect(await readProjectSecrets({ ...ctx, hostedMgmt: undefined })).toEqual(
      expected
    );
    expect(GET).not.toHaveBeenCalled();
  });
});

describe('secretStates', () => {
  it('calls a name production when its digest is the SHA-256 of the production value', () => {
    expect(secretStates(PRODUCTION)).toEqual(PRODUCTION_STATES);
  });

  it('calls a name development when its digest is the SHA-256 of the development value', () => {
    expect(secretStates(DEVELOPMENT)).toEqual({
      RESEND_API_KEY: 'development',
      STRIPE_SECRET_KEY: 'development',
      STRIPE_WEBHOOK_SECRET: 'development',
    });
  });

  it('calls a name missing when the project has no entry for it', () => {
    expect(secretStates(without(PRODUCTION, 'STRIPE_SECRET_KEY'))).toEqual({
      ...PRODUCTION_STATES,
      STRIPE_SECRET_KEY: 'missing',
    });
  });

  it('calls every name missing for a project with no secrets', () => {
    expect(secretStates([])).toEqual({
      RESEND_API_KEY: 'missing',
      STRIPE_SECRET_KEY: 'missing',
      STRIPE_WEBHOOK_SECRET: 'missing',
    });
  });

  it('calls a placeholder value other', () => {
    expect(
      secretStates(
        withValue(PRODUCTION, 'RESEND_API_KEY', digest('your-key-here'))
      )
    ).toEqual({ ...PRODUCTION_STATES, RESEND_API_KEY: 'other' });
  });

  it('calls a value that is not a digest of either file other', () => {
    expect(
      secretStates(withValue(PRODUCTION, 'RESEND_API_KEY', 'your-key-here'))
    ).toEqual({ ...PRODUCTION_STATES, RESEND_API_KEY: 'other' });
  });

  it('accepts an uppercase hex digest', () => {
    expect(
      secretStates(
        PRODUCTION.map((s) => ({ ...s, value: s.value.toUpperCase() }))
      )
    ).toEqual(PRODUCTION_STATES);
  });

  it('accepts the plaintext production value', () => {
    expect(
      secretStates(
        SECRET_NAMES.map((name) => ({ name, value: PRODUCTION_VALUES[name] }))
      )
    ).toEqual(PRODUCTION_STATES);
  });

  it('accepts the plaintext development value as development', () => {
    expect(
      secretStates(
        SECRET_NAMES.map((name) => ({ name, value: DEVELOPMENT_VALUES[name] }))
      )
    ).toEqual({
      RESEND_API_KEY: 'development',
      STRIPE_SECRET_KEY: 'development',
      STRIPE_WEBHOOK_SECRET: 'development',
    });
  });

  it('reads each name on its own, so one development name leaves the others production', () => {
    expect(
      secretStates(
        withValue(
          PRODUCTION,
          'STRIPE_WEBHOOK_SECRET',
          digest(DEVELOPMENT_VALUES.STRIPE_WEBHOOK_SECRET)
        )
      )
    ).toEqual({ ...PRODUCTION_STATES, STRIPE_WEBHOOK_SECRET: 'development' });
  });

  it('ignores secrets whose names are outside the seeded three', () => {
    expect(
      secretStates([
        ...PRODUCTION,
        { name: 'SENTRY_DSN', value: digest('https://sentry.test/1') },
        { name: 'LEGACY_FLAG', value: digest('on') },
      ])
    ).toEqual(PRODUCTION_STATES);
  });

  it('treats a name that differs only in case as another secret', () => {
    expect(
      secretStates([
        ...without(PRODUCTION, 'RESEND_API_KEY'),
        {
          name: 'resend_api_key',
          value: digest(PRODUCTION_VALUES.RESEND_API_KEY),
        },
      ])
    ).toEqual({ ...PRODUCTION_STATES, RESEND_API_KEY: 'missing' });
  });

  it('does not credit the production digest of another name', () => {
    expect(
      secretStates(
        withValue(
          PRODUCTION,
          'STRIPE_SECRET_KEY',
          digest(PRODUCTION_VALUES.RESEND_API_KEY)
        )
      )
    ).toEqual({ ...PRODUCTION_STATES, STRIPE_SECRET_KEY: 'other' });
  });

  it('does not credit the development digest of another name', () => {
    expect(
      secretStates(
        withValue(
          PRODUCTION,
          'STRIPE_SECRET_KEY',
          digest(DEVELOPMENT_VALUES.RESEND_API_KEY)
        )
      )
    ).toEqual({ ...PRODUCTION_STATES, STRIPE_SECRET_KEY: 'other' });
  });

  it('matches by equality, not by containing the production value', () => {
    expect(
      secretStates(
        withValue(
          PRODUCTION,
          'RESEND_API_KEY',
          `prefix_${PRODUCTION_VALUES.RESEND_API_KEY}`
        )
      )
    ).toEqual({ ...PRODUCTION_STATES, RESEND_API_KEY: 'other' });
  });

  it('does not credit the digest of the production value plus a trailing newline', () => {
    expect(
      secretStates(
        withValue(
          PRODUCTION,
          'RESEND_API_KEY',
          digest(`${PRODUCTION_VALUES.RESEND_API_KEY}\n`)
        )
      )
    ).toEqual({ ...PRODUCTION_STATES, RESEND_API_KEY: 'other' });
  });

  describe('a name listed more than once', () => {
    const second = (name: (typeof SECRET_NAMES)[0], value: string) => [
      ...PRODUCTION,
      { name, value },
    ];

    it('stays production when every entry holds the production value', () => {
      expect(
        secretStates(
          second('RESEND_API_KEY', digest(PRODUCTION_VALUES.RESEND_API_KEY))
        )
      ).toEqual(PRODUCTION_STATES);
    });

    it('is development when one entry holds the production value and one the development value', () => {
      expect(
        secretStates(
          second('RESEND_API_KEY', digest(DEVELOPMENT_VALUES.RESEND_API_KEY))
        )
      ).toEqual({ ...PRODUCTION_STATES, RESEND_API_KEY: 'development' });
    });

    it('is development whichever entry comes first', () => {
      expect(
        secretStates([
          { name: 'RESEND_API_KEY', value: DEVELOPMENT[0].value },
          ...PRODUCTION,
        ])
      ).toEqual({ ...PRODUCTION_STATES, RESEND_API_KEY: 'development' });
    });

    it('is development when a development entry sits beside an unrecognised one', () => {
      expect(
        secretStates([
          { name: 'RESEND_API_KEY', value: DEVELOPMENT[0].value },
          { name: 'RESEND_API_KEY', value: digest('your-key-here') },
          ...without(PRODUCTION, 'RESEND_API_KEY'),
        ])
      ).toEqual({ ...PRODUCTION_STATES, RESEND_API_KEY: 'development' });
    });

    it('is other when a production entry sits beside an unrecognised one', () => {
      expect(
        secretStates(second('RESEND_API_KEY', digest('your-key-here')))
      ).toEqual({ ...PRODUCTION_STATES, RESEND_API_KEY: 'other' });
    });
  });
});

describe('checkProductionValues', () => {
  it('passes when all three names hold the production value', () => {
    expect(checkProductionValues(probeOf(PRODUCTION))).toMatchObject({
      name: VALUES_CHECK_NAME,
      passed: true,
    });
  });

  it('passes with extra unrelated secrets on the project', () => {
    expect(
      checkProductionValues(
        probeOf([...PRODUCTION, { name: 'SENTRY_DSN', value: digest('dsn') }])
      )
    ).toMatchObject({ passed: true });
  });

  it('passes with uppercase hex digests', () => {
    expect(
      checkProductionValues(
        probeOf(PRODUCTION.map((s) => ({ ...s, value: s.value.toUpperCase() })))
      )
    ).toMatchObject({ passed: true });
  });

  it('passes when the API returns the plaintext production values', () => {
    expect(
      checkProductionValues(
        probeOf(
          SECRET_NAMES.map((name) => ({ name, value: PRODUCTION_VALUES[name] }))
        )
      )
    ).toMatchObject({ passed: true });
  });

  it('fails naming each name that holds the development value', () => {
    const check = checkProductionValues(probeOf(DEVELOPMENT));
    expect(check).toMatchObject({ name: VALUES_CHECK_NAME, passed: false });
    for (const name of SECRET_NAMES) {
      expect(check.notes).toContain(`${name}: holds the development value`);
    }
  });

  it('fails naming a name that is not set', () => {
    const check = checkProductionValues(
      probeOf(without(PRODUCTION, 'STRIPE_WEBHOOK_SECRET'))
    );
    expect(check.passed).toBe(false);
    expect(check.notes).toContain('STRIPE_WEBHOOK_SECRET: not set');
  });

  it('fails naming a placeholder as a value from neither env file', () => {
    const check = checkProductionValues(
      probeOf(withValue(PRODUCTION, 'RESEND_API_KEY', digest('your-key-here')))
    );
    expect(check.passed).toBe(false);
    expect(check.notes).toContain(
      'RESEND_API_KEY: holds a value from neither env file'
    );
  });

  it('lists only the names that are not production', () => {
    const check = checkProductionValues(
      probeOf(
        without(
          withValue(PRODUCTION, 'RESEND_API_KEY', 'x'),
          'STRIPE_SECRET_KEY'
        )
      )
    );
    expect(check.notes).toContain(
      'RESEND_API_KEY: holds a value from neither env file'
    );
    expect(check.notes).toContain('STRIPE_SECRET_KEY: not set');
    expect(check.notes).not.toContain('STRIPE_WEBHOOK_SECRET');
  });

  it('fails a name listed with both a production and a development entry', () => {
    const check = checkProductionValues(
      probeOf([
        ...PRODUCTION,
        { name: 'RESEND_API_KEY', value: DEVELOPMENT[0].value },
      ])
    );
    expect(check.passed).toBe(false);
    expect(check.notes).toContain(
      'RESEND_API_KEY: holds the development value'
    );
  });

  it('fails with the probe notes when the probe failed', () => {
    expect(
      checkProductionValues({ ok: false, notes: NO_HOSTED_PROJECT })
    ).toEqual({
      name: VALUES_CHECK_NAME,
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
    expect(
      checkProductionValues({
        ok: false,
        notes: "could not list the project's secrets: status 500 boom",
      })
    ).toMatchObject({
      passed: false,
      notes: "could not list the project's secrets: status 500 boom",
    });
  });

  it('never puts a value or a digest in the notes', () => {
    const check = checkProductionValues(
      probeOf([
        ...DEVELOPMENT.slice(0, 1),
        {
          name: 'STRIPE_SECRET_KEY',
          value: PRODUCTION_VALUES.STRIPE_SECRET_KEY,
        },
        { name: 'STRIPE_WEBHOOK_SECRET', value: 'hunter2-hunter2' },
      ])
    );
    const notes = check.notes ?? '';
    for (const secret of [
      ...ALL_VALUES,
      ...DEVELOPMENT.map((s) => s.value),
      ...PRODUCTION.map((s) => s.value),
      'hunter2-hunter2',
    ]) {
      expect(notes).not.toContain(secret);
    }
  });
});

describe('describeSecrets', () => {
  it('states what each seeded name holds after the run, in seed order', () => {
    expect(
      describeSecrets(
        probeOf([
          PRODUCTION[0],
          { name: 'STRIPE_WEBHOOK_SECRET', value: DEVELOPMENT[2].value },
        ])
      )
    ).toEqual([
      '- secrets on the project after the run: RESEND_API_KEY holds the production value; STRIPE_SECRET_KEY not set; STRIPE_WEBHOOK_SECRET holds the development value',
    ]);
  });

  it('states that every name holds the production value when the push worked', () => {
    expect(describeSecrets(probeOf(PRODUCTION))).toEqual([
      '- secrets on the project after the run: RESEND_API_KEY holds the production value; STRIPE_SECRET_KEY holds the production value; STRIPE_WEBHOOK_SECRET holds the production value',
    ]);
  });

  it('states that a placeholder holds a value from neither env file', () => {
    expect(
      describeSecrets(
        probeOf(withValue(PRODUCTION, 'RESEND_API_KEY', 'your-key-here'))
      ).join('\n')
    ).toContain('RESEND_API_KEY holds a value from neither env file');
  });

  it('says the secrets are unavailable, and why, when the probe failed', () => {
    expect(describeSecrets({ ok: false, notes: NO_HOSTED_PROJECT })).toEqual([
      `- secrets on the project: unavailable (${NO_HOSTED_PROJECT})`,
    ]);
    expect(describeSecrets({ ok: false, notes: 'connection reset' })).toEqual([
      '- secrets on the project: unavailable (connection reset)',
    ]);
  });

  it('never shows a value or a digest, even when the API returns plaintext', () => {
    const text = describeSecrets(
      probeOf([
        ...SECRET_NAMES.map((name) => ({
          name,
          value: PRODUCTION_VALUES[name],
        })),
        { name: 'SENTRY_DSN', value: 'dsn-value-1234' },
      ])
    ).join('\n');
    for (const secret of [
      ...ALL_VALUES,
      ...PRODUCTION.map((s) => s.value),
      'dsn-value-1234',
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
