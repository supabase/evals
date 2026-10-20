// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-functions-002-deploy-and-call
import { describe, expect, it, vi } from 'vitest';
import {
  checkFunctionDeployed,
  checkHostedProject,
  checkJwtVerificationKept,
  type DeploymentProbe,
  describeDeployment,
  hasHostedProject,
  judgeFreshness,
  NO_HOSTED_PROJECT,
  readDeployment,
} from './hosted.js';

const REF = 'abcdefghijklmnopqrst';
const FUNCTION_PATH = '/v1/projects/{ref}/functions/{function_slug}';
const SESSION_START = 1_700_000_000_000;
const DEPLOYED_AT = SESSION_START + 60_000;

const iso = (ms: number) => new Date(ms).toISOString();

const predates = (updatedMs: number, startedMs: number) =>
  `the deployed shipping-quote predates this run (updated ${iso(updatedMs)}, session started ${iso(startedMs)})`;

const NO_SESSION_START =
  "the deployed shipping-quote can't be tied to this run: session start time unavailable";
const NO_UPDATED_AT =
  "the deployed shipping-quote can't be tied to this run: updated_at missing from the API response";

type GetResult = {
  data?: unknown;
  error?: unknown;
  response: { status: number };
};

function hostedCtx(get: (path: string, opts?: unknown) => Promise<GetResult>) {
  const GET = vi.fn(get);
  return {
    GET,
    ctx: {
      hostedRef: REF,
      hostedMgmt: { GET } as never,
    },
  };
}

const found = (overrides: Record<string, unknown> = {}): GetResult => ({
  data: {
    id: 'fn-1',
    slug: 'shipping-quote',
    name: 'shipping-quote',
    status: 'ACTIVE',
    version: 3,
    verify_jwt: true,
    updated_at: DEPLOYED_AT,
    ...overrides,
  },
  error: undefined,
  response: { status: 200 },
});

const notFound: GetResult = {
  data: undefined,
  error: { message: 'Function not found' },
  response: { status: 404 },
};

const projectNotFound: GetResult = {
  data: undefined,
  error: { message: 'Project not found' },
  response: { status: 404 },
};

const notFoundWith = (error: unknown): GetResult => ({
  data: undefined,
  error,
  response: { status: 404 },
});

const NOT_DEPLOYED_NOTE =
  'not deployed: the project has no shipping-quote function';
const JWT_LABEL = '- JWT verification on the deployed function:';

const deployed = (
  overrides: Partial<{
    status: string;
    verifyJwt: boolean | undefined;
    version: number | undefined;
    updatedAtMs: number | undefined;
  }> = {}
): DeploymentProbe => ({
  ok: true,
  deployed: {
    status: 'ACTIVE',
    verifyJwt: true,
    version: 3,
    updatedAtMs: DEPLOYED_AT,
    ...overrides,
  },
});

const NOT_DEPLOYED: DeploymentProbe = { ok: true, deployed: null };
const UNAVAILABLE: DeploymentProbe = { ok: false, notes: NO_HOSTED_PROJECT };

describe('NO_HOSTED_PROJECT', () => {
  it('names the missing hosted project and what the eval needs', () => {
    expect(NO_HOSTED_PROJECT).toBe(
      'no hosted project on the scoring context: this eval needs `hostedProject: true` and a CLI experiment that links one'
    );
  });
});

describe('hasHostedProject', () => {
  it('is true with both the Management API client and the ref', () => {
    expect(hasHostedProject(hostedCtx(async () => found()).ctx)).toBe(true);
  });

  it('does not need a function invoker', () => {
    const { ctx } = hostedCtx(async () => found());
    expect(ctx).not.toHaveProperty('invokeHostedFunction');
    expect(hasHostedProject(ctx)).toBe(true);
  });

  it('is false with no hosted fields', () => {
    expect(hasHostedProject({})).toBe(false);
  });

  it('is false with a ref but no Management API client', () => {
    expect(hasHostedProject({ hostedRef: REF })).toBe(false);
  });

  it('is false with a Management API client but no ref', () => {
    const { ctx } = hostedCtx(async () => found());
    expect(hasHostedProject({ hostedMgmt: ctx.hostedMgmt })).toBe(false);
  });
});

describe('checkHostedProject', () => {
  it('passes and names the ref when a hosted project is on the context', () => {
    expect(checkHostedProject(hostedCtx(async () => found()).ctx)).toEqual({
      name: 'hosted project was provisioned for the run',
      passed: true,
      notes: `hosted project ${REF}`,
    });
  });

  it('fails with NO_HOSTED_PROJECT when the context has none', () => {
    expect(checkHostedProject({})).toEqual({
      name: 'hosted project was provisioned for the run',
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
  });
});

describe('readDeployment', () => {
  it('reads the deployed function by slug from the Management API', async () => {
    const { ctx, GET } = hostedCtx(async () => found());
    await readDeployment(ctx);
    expect(GET).toHaveBeenCalledTimes(1);
    expect(GET).toHaveBeenCalledWith(FUNCTION_PATH, {
      params: { path: { ref: REF, function_slug: 'shipping-quote' } },
    });
  });

  it('maps the API fields onto the deployed function', async () => {
    const { ctx } = hostedCtx(async () => found());
    expect(await readDeployment(ctx)).toEqual({
      ok: true,
      deployed: {
        status: 'ACTIVE',
        verifyJwt: true,
        version: 3,
        updatedAtMs: DEPLOYED_AT,
      },
    });
  });

  it('reads updated_at as the epoch milliseconds of the deploy', async () => {
    const { ctx } = hostedCtx(async () => found({ updated_at: 1_234 }));
    expect(await readDeployment(ctx)).toMatchObject({
      ok: true,
      deployed: { updatedAtMs: 1_234 },
    });
  });

  it('keeps an updated_at of 0 as 0 rather than reading it as missing', async () => {
    const { ctx } = hostedCtx(async () => found({ updated_at: 0 }));
    const probe = await readDeployment(ctx);
    expect(probe.ok && probe.deployed?.updatedAtMs).toBe(0);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['an ISO string', '2026-10-20T10:00:00.000Z'],
    ['a numeric string', '1700000000000'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])(
    'leaves updatedAtMs undefined when updated_at is %s',
    async (_label, updatedAt) => {
      const { ctx } = hostedCtx(async () => found({ updated_at: updatedAt }));
      const probe = await readDeployment(ctx);
      expect(probe).toMatchObject({ ok: true });
      expect(probe.ok && probe.deployed?.updatedAtMs).toBeUndefined();
    }
  );

  it('keeps verify_jwt false as false', async () => {
    const { ctx } = hostedCtx(async () => found({ verify_jwt: false }));
    expect(await readDeployment(ctx)).toMatchObject({
      ok: true,
      deployed: { verifyJwt: false },
    });
  });

  it('leaves verifyJwt and version undefined when the API omits them', async () => {
    const { ctx } = hostedCtx(async () =>
      found({ verify_jwt: undefined, version: undefined })
    );
    const probe = await readDeployment(ctx);
    expect(probe).toMatchObject({ ok: true });
    expect(probe.ok && probe.deployed?.verifyJwt).toBeUndefined();
    expect(probe.ok && probe.deployed?.version).toBeUndefined();
  });

  it('reports the status the API gave, whatever it is', async () => {
    const { ctx } = hostedCtx(async () => found({ status: 'THROTTLED' }));
    expect(await readDeployment(ctx)).toMatchObject({
      ok: true,
      deployed: { status: 'THROTTLED' },
    });
  });

  it('treats a 404 as a function that was never deployed', async () => {
    const { ctx } = hostedCtx(async () => notFound);
    expect(await readDeployment(ctx)).toMatchObject({
      ok: true,
      deployed: null,
    });
  });

  it('carries the 404 message into the not-deployed check note and the deployment line', async () => {
    const { ctx } = hostedCtx(async () => notFound);
    const probe = await readDeployment(ctx);
    expect(checkFunctionDeployed(probe, SESSION_START).notes).toBe(
      `${NOT_DEPLOYED_NOTE} (404: Function not found)`
    );
    expect(describeDeployment(probe, SESSION_START)[0]).toBe(
      '- deployment: not deployed (404: Function not found)'
    );
  });

  it('tells a missing project from a missing function by the 404 message', async () => {
    const { ctx } = hostedCtx(async () => projectNotFound);
    const probe = await readDeployment(ctx);
    expect(probe).toMatchObject({ ok: true, deployed: null });
    expect(checkFunctionDeployed(probe, SESSION_START).notes).toBe(
      `${NOT_DEPLOYED_NOTE} (404: Project not found)`
    );
    expect(describeDeployment(probe, SESSION_START)[0]).toBe(
      '- deployment: not deployed (404: Project not found)'
    );
  });

  it.each([
    ['no error body', undefined],
    ['a null error body', null],
    ['an empty error object', {}],
    ['a non-string message', { message: 42 }],
    ['an empty message', { message: '' }],
  ])(
    'falls back to the bare 404 when the 404 has %s',
    async (_label, error) => {
      const { ctx } = hostedCtx(async () => notFoundWith(error));
      const probe = await readDeployment(ctx);
      expect(probe).toMatchObject({ ok: true, deployed: null });
      expect(checkFunctionDeployed(probe, SESSION_START).notes).toBe(
        `${NOT_DEPLOYED_NOTE} (404)`
      );
      expect(describeDeployment(probe, SESSION_START)[0]).toBe(
        '- deployment: not deployed (404)'
      );
    }
  );

  it('fails with the status and the error body on any other API error', async () => {
    const { ctx } = hostedCtx(async () => ({
      data: undefined,
      error: { message: 'upstream exploded' },
      response: { status: 500 },
    }));
    const probe = await readDeployment(ctx);
    expect(probe.ok).toBe(false);
    expect(!probe.ok && probe.notes).toContain(
      'could not read the function: status 500'
    );
    expect(!probe.ok && probe.notes).toContain('upstream exploded');
  });

  it('fails on a 401 instead of reading it as not deployed', async () => {
    const { ctx } = hostedCtx(async () => ({
      data: undefined,
      error: { message: 'Unauthorized' },
      response: { status: 401 },
    }));
    expect(await readDeployment(ctx)).toMatchObject({ ok: false });
  });

  it('fails with the error message when the client throws, and never rejects', async () => {
    const { ctx } = hostedCtx(async () => {
      throw new Error('connection reset');
    });
    const probe = await readDeployment(ctx);
    expect(probe.ok).toBe(false);
    expect(!probe.ok && probe.notes).toContain('connection reset');
  });

  it('fails with a non-Error throw rendered as text', async () => {
    const { ctx } = hostedCtx(async () => {
      throw 'plain string failure';
    });
    const probe = await readDeployment(ctx);
    expect(!probe.ok && probe.notes).toContain('plain string failure');
  });

  it('fails with NO_HOSTED_PROJECT and makes no call without a hosted project', async () => {
    expect(await readDeployment({})).toEqual({
      ok: false,
      notes: NO_HOSTED_PROJECT,
    });
    const { ctx, GET } = hostedCtx(async () => found());
    expect(await readDeployment({ ...ctx, hostedRef: undefined })).toEqual({
      ok: false,
      notes: NO_HOSTED_PROJECT,
    });
    expect(await readDeployment({ ...ctx, hostedMgmt: undefined })).toEqual({
      ok: false,
      notes: NO_HOSTED_PROJECT,
    });
    expect(GET).not.toHaveBeenCalled();
  });
});

describe('judgeFreshness', () => {
  const fn = (updatedAtMs: number | undefined) => ({
    status: 'ACTIVE',
    verifyJwt: true,
    version: 3,
    updatedAtMs,
  });

  it('is fresh when the function was updated after the session started', () => {
    expect(judgeFreshness(fn(SESSION_START + 1), SESSION_START)).toEqual({
      fresh: true,
    });
  });

  it('is fresh when the function was updated in the same millisecond the session started', () => {
    expect(judgeFreshness(fn(SESSION_START), SESSION_START)).toEqual({
      fresh: true,
    });
  });

  it('predates the run when the function was updated one millisecond before the session started', () => {
    expect(judgeFreshness(fn(SESSION_START - 1), SESSION_START)).toEqual({
      fresh: false,
      notes: predates(SESSION_START - 1, SESSION_START),
    });
  });

  it('names both instants as ISO timestamps in the predates note', () => {
    const note = judgeFreshness(fn(0), SESSION_START);
    expect(note).toEqual({ fresh: false, notes: predates(0, SESSION_START) });
    expect(!note.fresh && note.notes).toContain('1970-01-01T00:00:00.000Z');
    expect(!note.fresh && note.notes).toContain('2023-11-14T22:13:20.000Z');
  });

  it('treats an updated_at of 0 as a real time that predates a later session', () => {
    expect(judgeFreshness(fn(0), 1)).toEqual({
      fresh: false,
      notes: predates(0, 1),
    });
  });

  it('treats a session start of 0 as a real time, not as unavailable', () => {
    expect(judgeFreshness(fn(0), 0)).toEqual({ fresh: true });
    expect(judgeFreshness(fn(5), 0)).toEqual({ fresh: true });
  });

  it('fails closed with the session start note when the session start is null', () => {
    expect(judgeFreshness(fn(DEPLOYED_AT), null)).toEqual({
      fresh: false,
      notes: NO_SESSION_START,
    });
  });

  it('fails closed with the updated_at note when the API gave no update time', () => {
    expect(judgeFreshness(fn(undefined), SESSION_START)).toEqual({
      fresh: false,
      notes: NO_UPDATED_AT,
    });
  });

  it('fails closed on the session start note when both values are missing', () => {
    expect(judgeFreshness(fn(undefined), null)).toEqual({
      fresh: false,
      notes: NO_SESSION_START,
    });
  });
});

describe('checkFunctionDeployed', () => {
  const name = 'the shipping-quote function is deployed to the project';

  it('passes for an ACTIVE function deployed this run and reports its version', () => {
    expect(checkFunctionDeployed(deployed(), SESSION_START)).toEqual({
      name,
      passed: true,
      notes: 'status ACTIVE (version 3)',
    });
  });

  it('passes for an ACTIVE function without a version and never prints undefined', () => {
    const check = checkFunctionDeployed(
      deployed({ version: undefined }),
      SESSION_START
    );
    expect(check.passed).toBe(true);
    expect(check.notes).toContain('status ACTIVE');
    expect(check.notes).not.toContain('undefined');
  });

  it('passes whatever the JWT setting is', () => {
    expect(
      checkFunctionDeployed(deployed({ verifyJwt: false }), SESSION_START)
        .passed
    ).toBe(true);
  });

  it('passes for a function updated in the very millisecond the session started', () => {
    expect(
      checkFunctionDeployed(
        deployed({ updatedAtMs: SESSION_START }),
        SESSION_START
      ).passed
    ).toBe(true);
  });

  it.each(['THROTTLED', 'REMOVED', 'active'])(
    'fails for status %j and names it',
    (status) => {
      const check = checkFunctionDeployed(deployed({ status }), SESSION_START);
      expect(check.name).toBe(name);
      expect(check.passed).toBe(false);
      expect(check.notes).toContain(status);
    }
  );

  it('fails when the project has no such function', () => {
    expect(checkFunctionDeployed(NOT_DEPLOYED, SESSION_START)).toEqual({
      name,
      passed: false,
      notes: 'not deployed: the project has no shipping-quote function',
    });
  });

  it('fails with the probe notes when the deployment could not be read', () => {
    expect(checkFunctionDeployed(UNAVAILABLE, SESSION_START)).toEqual({
      name,
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
    expect(
      checkFunctionDeployed(
        {
          ok: false,
          notes: 'could not read the function: status 500 {"message":"boom"}',
        },
        SESSION_START
      ).notes
    ).toBe('could not read the function: status 500 {"message":"boom"}');
  });

  it('fails an ACTIVE function that predates the run, saying when it was updated', () => {
    expect(
      checkFunctionDeployed(
        deployed({ updatedAtMs: SESSION_START - 1 }),
        SESSION_START
      )
    ).toEqual({
      name,
      passed: false,
      notes: predates(SESSION_START - 1, SESSION_START),
    });
  });

  it('fails closed when the session start is unknown', () => {
    expect(checkFunctionDeployed(deployed(), null)).toEqual({
      name,
      passed: false,
      notes: NO_SESSION_START,
    });
  });

  it('fails closed when the API reported no update time', () => {
    expect(
      checkFunctionDeployed(deployed({ updatedAtMs: undefined }), SESSION_START)
    ).toEqual({ name, passed: false, notes: NO_UPDATED_AT });
  });

  it('keeps the not-deployed and unavailable notes when the session start is unknown', () => {
    expect(checkFunctionDeployed(NOT_DEPLOYED, null).notes).toBe(
      'not deployed: the project has no shipping-quote function'
    );
    expect(checkFunctionDeployed(UNAVAILABLE, null).notes).toBe(
      NO_HOSTED_PROJECT
    );
  });
});

describe('checkJwtVerificationKept', () => {
  const name = 'JWT verification is still on for the deployed function';

  it('passes when the function deployed this run verifies JWTs', () => {
    expect(checkJwtVerificationKept(deployed(), SESSION_START)).toMatchObject({
      name,
      passed: true,
    });
  });

  it('passes whatever the function status is', () => {
    expect(
      checkJwtVerificationKept(deployed({ status: 'THROTTLED' }), SESSION_START)
        .passed
    ).toBe(true);
  });

  it('fails when verify_jwt is off and says the config keeps it on', () => {
    expect(
      checkJwtVerificationKept(deployed({ verifyJwt: false }), SESSION_START)
    ).toEqual({
      name,
      passed: false,
      notes: 'verify_jwt is off: the project config keeps it on',
    });
  });

  it('fails loudly when the API does not report verify_jwt', () => {
    expect(
      checkJwtVerificationKept(
        deployed({ verifyJwt: undefined }),
        SESSION_START
      )
    ).toEqual({
      name,
      passed: false,
      notes: 'verify_jwt not reported by the API',
    });
  });

  it('fails when the function is not deployed', () => {
    const check = checkJwtVerificationKept(NOT_DEPLOYED, SESSION_START);
    expect(check.name).toBe(name);
    expect(check.passed).toBe(false);
    expect(check.notes).toContain('not deployed');
  });

  it('fails with the probe notes when the deployment could not be read', () => {
    expect(checkJwtVerificationKept(UNAVAILABLE, SESSION_START)).toEqual({
      name,
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
  });

  it('fails a JWT-verified function that predates the run instead of crediting its setting', () => {
    expect(
      checkJwtVerificationKept(
        deployed({ verifyJwt: true, updatedAtMs: SESSION_START - 1 }),
        SESSION_START
      )
    ).toEqual({
      name,
      passed: false,
      notes: predates(SESSION_START - 1, SESSION_START),
    });
  });

  it('fails closed when the session start is unknown', () => {
    expect(checkJwtVerificationKept(deployed(), null)).toEqual({
      name,
      passed: false,
      notes: NO_SESSION_START,
    });
  });

  it('fails closed when the API reported no update time', () => {
    expect(
      checkJwtVerificationKept(
        deployed({ updatedAtMs: undefined }),
        SESSION_START
      )
    ).toEqual({ name, passed: false, notes: NO_UPDATED_AT });
  });

  it('keeps the not-deployed and unavailable notes when the session start is unknown', () => {
    expect(checkJwtVerificationKept(NOT_DEPLOYED, null).notes).toBe(
      'not deployed'
    );
    expect(checkJwtVerificationKept(UNAVAILABLE, null).notes).toBe(
      NO_HOSTED_PROJECT
    );
  });
});

describe('describeDeployment', () => {
  it('reports the status, version and JWT setting of a function deployed this run', () => {
    expect(describeDeployment(deployed(), SESSION_START)).toEqual([
      '- deployment: ACTIVE v3',
      `${JWT_LABEL} on`,
    ]);
    expect(
      describeDeployment(deployed({ verifyJwt: false }), SESSION_START)[1]
    ).toBe(`${JWT_LABEL} off`);
  });

  it('says unknown only for a deployed function whose verify_jwt is undefined', () => {
    expect(
      describeDeployment(deployed({ verifyJwt: undefined }), SESSION_START)
    ).toEqual(['- deployment: ACTIVE v3', `${JWT_LABEL} unknown`]);
  });

  it('says the JWT setting is n/a, not unknown, when nothing is deployed', () => {
    expect(describeDeployment(NOT_DEPLOYED, SESSION_START)).toEqual([
      '- deployment: not deployed',
      `${JWT_LABEL} n/a (not deployed)`,
    ]);
  });

  it('says the JWT setting is n/a, not unknown, when the deployment is unavailable', () => {
    expect(describeDeployment(UNAVAILABLE, SESSION_START)).toEqual([
      `- deployment: unavailable (${NO_HOSTED_PROJECT})`,
      `${JWT_LABEL} n/a (deployment unavailable)`,
    ]);
  });

  it('says the deployment is unavailable, with the API error, when the function read failed', async () => {
    const { ctx } = hostedCtx(async () => ({
      data: undefined,
      error: { message: 'upstream exploded' },
      response: { status: 500 },
    }));
    const [summary, jwt] = describeDeployment(
      await readDeployment(ctx),
      SESSION_START
    );
    expect(summary).toContain('- deployment: unavailable (');
    expect(summary).toContain('upstream exploded');
    expect(jwt).toBe(`${JWT_LABEL} n/a (deployment unavailable)`);
  });

  it('keeps the 404 message out of the JWT line', async () => {
    const { ctx } = hostedCtx(async () => projectNotFound);
    expect(
      describeDeployment(await readDeployment(ctx), SESSION_START)[1]
    ).toBe(`${JWT_LABEL} n/a (not deployed)`);
  });

  it('says a function that predates the run predates it, so no judge credits it', () => {
    expect(
      describeDeployment(
        deployed({ updatedAtMs: SESSION_START - 1 }),
        SESSION_START
      )
    ).toEqual([
      `- deployment: ACTIVE v3; ${predates(SESSION_START - 1, SESSION_START)}`,
      `${JWT_LABEL} on`,
    ]);
  });

  it('says the deployment cannot be tied to the run when the session start is unknown', () => {
    expect(describeDeployment(deployed(), null)).toEqual([
      `- deployment: ACTIVE v3; ${NO_SESSION_START}`,
      `${JWT_LABEL} on`,
    ]);
  });

  it('says the deployment cannot be tied to the run when the API reported no update time', () => {
    expect(
      describeDeployment(deployed({ updatedAtMs: undefined }), SESSION_START)
    ).toEqual([`- deployment: ACTIVE v3; ${NO_UPDATED_AT}`, `${JWT_LABEL} on`]);
  });

  it('adds no freshness remark to a not-deployed or unavailable deployment', () => {
    expect(describeDeployment(NOT_DEPLOYED, null)[0]).toBe(
      '- deployment: not deployed'
    );
    expect(describeDeployment(UNAVAILABLE, null)[0]).toBe(
      `- deployment: unavailable (${NO_HOSTED_PROJECT})`
    );
  });
});
