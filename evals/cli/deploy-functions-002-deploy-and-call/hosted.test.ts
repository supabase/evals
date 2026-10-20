// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-functions-002-deploy-and-call
import { describe, expect, it, vi } from 'vitest';
import {
  checkFunctionDeployed,
  checkHostedProject,
  checkJwtVerificationKept,
  type DeploymentProbe,
  hasHostedProject,
  NO_HOSTED_PROJECT,
  readDeployment,
} from './hosted.js';

const REF = 'abcdefghijklmnopqrst';
const FUNCTION_PATH = '/v1/projects/{ref}/functions/{function_slug}';

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

const deployed = (
  overrides: Partial<{
    status: string;
    verifyJwt: boolean | undefined;
    version: number | undefined;
  }> = {}
): DeploymentProbe => ({
  ok: true,
  deployed: { status: 'ACTIVE', verifyJwt: true, version: 3, ...overrides },
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
      deployed: { status: 'ACTIVE', verifyJwt: true, version: 3 },
    });
  });

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
    expect(await readDeployment(ctx)).toEqual({ ok: true, deployed: null });
  });

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

describe('checkFunctionDeployed', () => {
  const name = 'the shipping-quote function is deployed to the project';

  it('passes for an ACTIVE function and reports its version', () => {
    expect(checkFunctionDeployed(deployed())).toEqual({
      name,
      passed: true,
      notes: 'status ACTIVE (version 3)',
    });
  });

  it('passes for an ACTIVE function without a version and never prints undefined', () => {
    const check = checkFunctionDeployed(deployed({ version: undefined }));
    expect(check.passed).toBe(true);
    expect(check.notes).toContain('status ACTIVE');
    expect(check.notes).not.toContain('undefined');
  });

  it('passes whatever the JWT setting is', () => {
    expect(checkFunctionDeployed(deployed({ verifyJwt: false })).passed).toBe(
      true
    );
  });

  it.each(['THROTTLED', 'REMOVED', 'active'])(
    'fails for status %j and names it',
    (status) => {
      const check = checkFunctionDeployed(deployed({ status }));
      expect(check.name).toBe(name);
      expect(check.passed).toBe(false);
      expect(check.notes).toContain(status);
    }
  );

  it('fails when the project has no such function', () => {
    expect(checkFunctionDeployed(NOT_DEPLOYED)).toEqual({
      name,
      passed: false,
      notes: 'not deployed: the project has no shipping-quote function',
    });
  });

  it('fails with the probe notes when the deployment could not be read', () => {
    expect(checkFunctionDeployed(UNAVAILABLE)).toEqual({
      name,
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
    expect(
      checkFunctionDeployed({
        ok: false,
        notes: 'could not read the function: status 500 {"message":"boom"}',
      }).notes
    ).toBe('could not read the function: status 500 {"message":"boom"}');
  });
});

describe('checkJwtVerificationKept', () => {
  const name = 'JWT verification is still on for the deployed function';

  it('passes when the deployed function verifies JWTs', () => {
    expect(checkJwtVerificationKept(deployed())).toMatchObject({
      name,
      passed: true,
    });
  });

  it('passes whatever the function status is', () => {
    expect(
      checkJwtVerificationKept(deployed({ status: 'THROTTLED' })).passed
    ).toBe(true);
  });

  it('fails when verify_jwt is off and says the config keeps it on', () => {
    expect(checkJwtVerificationKept(deployed({ verifyJwt: false }))).toEqual({
      name,
      passed: false,
      notes: 'verify_jwt is off: the project config keeps it on',
    });
  });

  it('fails loudly when the API does not report verify_jwt', () => {
    expect(
      checkJwtVerificationKept(deployed({ verifyJwt: undefined }))
    ).toEqual({
      name,
      passed: false,
      notes: 'verify_jwt not reported by the API',
    });
  });

  it('fails when the function is not deployed', () => {
    const check = checkJwtVerificationKept(NOT_DEPLOYED);
    expect(check.name).toBe(name);
    expect(check.passed).toBe(false);
    expect(check.notes).toContain('not deployed');
  });

  it('fails with the probe notes when the deployment could not be read', () => {
    expect(checkJwtVerificationKept(UNAVAILABLE)).toEqual({
      name,
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
  });
});
