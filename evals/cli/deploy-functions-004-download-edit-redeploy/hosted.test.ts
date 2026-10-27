// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-functions-004-download-edit-redeploy
import { describe, expect, it, vi } from 'vitest';
import {
  checkFunctionRedeployed,
  checkHostedProject,
  checkJwtVerificationKept,
  type DeploymentProbe,
  describeDeployment,
  hasHostedProject,
  judgeRedeploy,
  NO_HOSTED_PROJECT,
  readDeployment,
} from './hosted.js';

const REF = 'abcdefghijklmnopqrst';
const FUNCTION_PATH = '/v1/projects/{ref}/functions/{function_slug}';
const SESSION_START = 1_700_000_000_000;
const REDEPLOYED_AT = SESSION_START + 60_000;

const iso = (ms: number) => new Date(ms).toISOString();

const BEFORE_THIS_RUN = (updatedMs: number, startedMs: number) =>
  `still the deployment from before this run (updated ${iso(updatedMs)}, session started ${iso(startedMs)})`;
const MATCHES_SEED = (version: number) =>
  `version ${version} matches the seeded deployment, so this run's redeploy can't be told apart from the seed`;
const NO_SESSION_START = "can't be tied to this run";
const SESSION_START_MISSING = 'session start time unavailable';
const UPDATED_AT_MISSING = 'updated_at missing';

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
    slug: 'apply-promo',
    name: 'apply-promo',
    status: 'ACTIVE',
    version: 2,
    verify_jwt: true,
    updated_at: REDEPLOYED_AT,
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
  'not deployed: the project has no apply-promo function';
const JWT_LABEL = '- JWT verification on the deployed function:';

type FnOverrides = Partial<{
  status: string;
  verifyJwt: boolean | undefined;
  version: number | undefined;
  updatedAtMs: number | undefined;
}>;

const deployed = (overrides: FnOverrides = {}): DeploymentProbe => ({
  ok: true,
  deployed: {
    status: 'ACTIVE',
    verifyJwt: true,
    version: 2,
    updatedAtMs: REDEPLOYED_AT,
    ...overrides,
  },
});

const fnOf = (overrides: FnOverrides = {}) => {
  const probe = deployed(overrides);
  if (!probe.ok || probe.deployed === null) throw new Error('unreachable');
  return probe.deployed;
};

const NOT_DEPLOYED: DeploymentProbe = { ok: true, deployed: null };
const UNAVAILABLE: DeploymentProbe = { ok: false, notes: NO_HOSTED_PROJECT };

const notRedeployedNotes = (overrides: FnOverrides, start = SESSION_START) => {
  const verdict = judgeRedeploy(fnOf(overrides), start);
  if (verdict.redeployed) throw new Error('expected a function not redeployed');
  return verdict.notes;
};

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

  it('fails with NO_HOSTED_PROJECT, without throwing, when the context has none', () => {
    expect(checkHostedProject({})).toEqual({
      name: 'hosted project was provisioned for the run',
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
  });
});

describe('readDeployment', () => {
  it('reads the apply-promo function by slug from the Management API', async () => {
    const { ctx, GET } = hostedCtx(async () => found());
    await readDeployment(ctx);
    expect(GET).toHaveBeenCalledTimes(1);
    expect(GET).toHaveBeenCalledWith(FUNCTION_PATH, {
      params: { path: { ref: REF, function_slug: 'apply-promo' } },
    });
  });

  it('maps the API fields onto the deployed function', async () => {
    const { ctx } = hostedCtx(async () => found());
    expect(await readDeployment(ctx)).toEqual({
      ok: true,
      deployed: {
        status: 'ACTIVE',
        verifyJwt: true,
        version: 2,
        updatedAtMs: REDEPLOYED_AT,
      },
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

  it('treats a 404 as a function that is not deployed', async () => {
    const { ctx } = hostedCtx(async () => notFound);
    expect(await readDeployment(ctx)).toMatchObject({
      ok: true,
      deployed: null,
    });
  });

  it('carries the 404 message into the not-deployed check note and the deployment line', async () => {
    const { ctx } = hostedCtx(async () => notFound);
    const probe = await readDeployment(ctx);
    expect(checkFunctionRedeployed(probe, SESSION_START).notes).toBe(
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
    expect(checkFunctionRedeployed(probe, SESSION_START).notes).toBe(
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
      expect(checkFunctionRedeployed(probe, SESSION_START).notes).toBe(
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

describe('judgeRedeploy', () => {
  it('counts a function at version 2 updated after the session started as redeployed', () => {
    expect(judgeRedeploy(fnOf(), SESSION_START)).toEqual({ redeployed: true });
  });

  it('counts a function updated in the very millisecond the session started', () => {
    expect(
      judgeRedeploy(fnOf({ updatedAtMs: SESSION_START }), SESSION_START)
    ).toEqual({ redeployed: true });
  });

  it('does not count a function updated one millisecond before the session started, and names both instants', () => {
    expect(
      judgeRedeploy(fnOf({ updatedAtMs: SESSION_START - 1 }), SESSION_START)
    ).toEqual({
      redeployed: false,
      notes: expect.stringContaining(
        BEFORE_THIS_RUN(SESSION_START - 1, SESSION_START)
      ),
    });
  });

  it('writes both instants as ISO timestamps', () => {
    const verdict = judgeRedeploy(fnOf({ updatedAtMs: 0 }), SESSION_START);
    expect(!verdict.redeployed && verdict.notes).toContain(
      '1970-01-01T00:00:00.000Z'
    );
    expect(!verdict.redeployed && verdict.notes).toContain(
      '2023-11-14T22:13:20.000Z'
    );
  });

  it('does not count the seeded version 1 even when it was updated after the session started', () => {
    expect(
      judgeRedeploy(
        fnOf({ version: 1, updatedAtMs: REDEPLOYED_AT }),
        SESSION_START
      )
    ).toEqual({
      redeployed: false,
      notes: expect.stringContaining(MATCHES_SEED(1)),
    });
  });

  it('does not count a version below the seeded one', () => {
    expect(judgeRedeploy(fnOf({ version: 0 }), SESSION_START)).toMatchObject({
      redeployed: false,
      notes: expect.stringContaining(MATCHES_SEED(0)),
    });
  });

  it('does not count a function whose version the API did not report, and never prints undefined', () => {
    const notes = notRedeployedNotes({ version: undefined });
    expect(notes).toContain(NO_SESSION_START);
    expect(notes).toContain('version missing');
    expect(notes).not.toContain('undefined');
  });

  it('says the seed cannot be told apart from a redeploy, not that the function predates the run, when it was updated after the session started at the seeded version', () => {
    const notes = notRedeployedNotes({
      version: 1,
      updatedAtMs: REDEPLOYED_AT,
    });
    expect(notes).toContain(MATCHES_SEED(1));
    expect(notes).not.toContain('from before this run');
  });

  it('counts version 2, the first redeploy of the seeded function', () => {
    expect(judgeRedeploy(fnOf({ version: 2 }), SESSION_START).redeployed).toBe(
      true
    );
  });

  it('says the function predates the run, not that it is the seeded one, when it is both', () => {
    const notes = notRedeployedNotes({
      version: 1,
      updatedAtMs: SESSION_START - 1,
    });
    expect(notes).toContain(BEFORE_THIS_RUN(SESSION_START - 1, SESSION_START));
    expect(notes).not.toContain('seeded');
  });

  it('fails closed, naming the missing session start, when the session start is null', () => {
    const notes = notRedeployedNotes({}, null as never);
    expect(notes).toContain(NO_SESSION_START);
    expect(notes).toContain(SESSION_START_MISSING);
  });

  it('fails closed, naming updated_at, when the API gave no update time', () => {
    const notes = notRedeployedNotes({ updatedAtMs: undefined });
    expect(notes).toContain(NO_SESSION_START);
    expect(notes).toContain(UPDATED_AT_MISSING);
  });

  it('names the missing session start first when both values are missing', () => {
    const notes = notRedeployedNotes({ updatedAtMs: undefined }, null as never);
    expect(notes).toContain(SESSION_START_MISSING);
    expect(notes).not.toContain(UPDATED_AT_MISSING);
  });

  it('fails closed on a null session start even for a seeded version', () => {
    const notes = notRedeployedNotes({ version: 1 }, null as never);
    expect(notes).toContain(SESSION_START_MISSING);
  });

  it('treats a session start of 0 and an updated_at of 0 as real times', () => {
    expect(judgeRedeploy(fnOf({ updatedAtMs: 0 }), 0).redeployed).toBe(true);
    expect(judgeRedeploy(fnOf({ updatedAtMs: 0 }), 1).redeployed).toBe(false);
  });
});

describe('checkFunctionRedeployed', () => {
  const name = 'the apply-promo function was redeployed during the run';

  it('passes for an ACTIVE function redeployed this run and reports its status and version', () => {
    const check = checkFunctionRedeployed(deployed(), SESSION_START);
    expect(check).toMatchObject({ name, passed: true });
    expect(check.notes).toContain('ACTIVE');
    expect(check.notes).toContain('version 2');
  });

  it('passes whatever the JWT setting is', () => {
    expect(
      checkFunctionRedeployed(deployed({ verifyJwt: false }), SESSION_START)
        .passed
    ).toBe(true);
  });

  it('passes for a function updated in the very millisecond the session started', () => {
    expect(
      checkFunctionRedeployed(
        deployed({ updatedAtMs: SESSION_START }),
        SESSION_START
      ).passed
    ).toBe(true);
  });

  it.each(['THROTTLED', 'REMOVED', 'active'])(
    'fails a function redeployed this run whose status is %j, and names it',
    (status) => {
      const check = checkFunctionRedeployed(
        deployed({ status }),
        SESSION_START
      );
      expect(check.name).toBe(name);
      expect(check.passed).toBe(false);
      expect(check.notes).toContain(status);
    }
  );

  it('fails the seeded version 1 untouched since boot, saying it is still the seeded deployment', () => {
    const check = checkFunctionRedeployed(
      deployed({ version: 1, updatedAtMs: SESSION_START }),
      SESSION_START
    );
    expect(check).toMatchObject({ name, passed: false });
    expect(check.notes).toContain(MATCHES_SEED(1));
  });

  it('fails an ACTIVE function that predates the run, saying when it was updated', () => {
    const check = checkFunctionRedeployed(
      deployed({ updatedAtMs: SESSION_START - 1 }),
      SESSION_START
    );
    expect(check).toMatchObject({ name, passed: false });
    expect(check.notes).toContain(
      BEFORE_THIS_RUN(SESSION_START - 1, SESSION_START)
    );
  });

  it('fails with the same notes judgeRedeploy gives when the function was not redeployed', () => {
    for (const overrides of [
      { version: 1 },
      { updatedAtMs: SESSION_START - 1 },
      { updatedAtMs: undefined },
    ]) {
      expect(
        checkFunctionRedeployed(deployed(overrides), SESSION_START).notes
      ).toContain(notRedeployedNotes(overrides));
    }
  });

  it('fails when the project has no apply-promo function', () => {
    expect(checkFunctionRedeployed(NOT_DEPLOYED, SESSION_START)).toEqual({
      name,
      passed: false,
      notes: NOT_DEPLOYED_NOTE,
    });
  });

  it('fails with the probe notes when the deployment could not be read', () => {
    expect(checkFunctionRedeployed(UNAVAILABLE, SESSION_START)).toEqual({
      name,
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
    expect(
      checkFunctionRedeployed(
        {
          ok: false,
          notes: 'could not read the function: status 500 {"message":"boom"}',
        },
        SESSION_START
      ).notes
    ).toBe('could not read the function: status 500 {"message":"boom"}');
  });

  it('fails closed when the session start is unknown', () => {
    const check = checkFunctionRedeployed(deployed(), null);
    expect(check.passed).toBe(false);
    expect(check.notes).toContain(SESSION_START_MISSING);
  });

  it('fails closed when the API reported no update time', () => {
    const check = checkFunctionRedeployed(
      deployed({ updatedAtMs: undefined }),
      SESSION_START
    );
    expect(check.passed).toBe(false);
    expect(check.notes).toContain(UPDATED_AT_MISSING);
  });

  it('keeps the not-deployed and unavailable notes when the session start is unknown', () => {
    expect(checkFunctionRedeployed(NOT_DEPLOYED, null).notes).toBe(
      NOT_DEPLOYED_NOTE
    );
    expect(checkFunctionRedeployed(UNAVAILABLE, null).notes).toBe(
      NO_HOSTED_PROJECT
    );
  });
});

describe('checkJwtVerificationKept', () => {
  const name = 'JWT verification is still on for the redeployed function';

  it('passes when the function redeployed this run verifies JWTs', () => {
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

  it('fails when verify_jwt is off and says the fix did not ask to change it', () => {
    expect(
      checkJwtVerificationKept(deployed({ verifyJwt: false }), SESSION_START)
    ).toEqual({
      name,
      passed: false,
      notes:
        "verify_jwt is off: the deployed function had it on and the fix didn't ask to change it",
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

  it('fails the untouched seeded function instead of crediting its verify_jwt of true', () => {
    expect(
      checkJwtVerificationKept(
        deployed({ verifyJwt: true, version: 1 }),
        SESSION_START
      )
    ).toEqual({
      name,
      passed: false,
      notes: notRedeployedNotes({ verifyJwt: true, version: 1 }),
    });
  });

  it('fails a JWT-verified function that predates the run with the judgeRedeploy notes', () => {
    expect(
      checkJwtVerificationKept(
        deployed({ updatedAtMs: SESSION_START - 1 }),
        SESSION_START
      )
    ).toEqual({
      name,
      passed: false,
      notes: notRedeployedNotes({ updatedAtMs: SESSION_START - 1 }),
    });
  });

  it('says verify_jwt is off for a function that predates the run only through the not-redeployed note', () => {
    const check = checkJwtVerificationKept(
      deployed({ verifyJwt: false, version: 1 }),
      SESSION_START
    );
    expect(check.passed).toBe(false);
    expect(check.notes).toBe(
      notRedeployedNotes({ verifyJwt: false, version: 1 })
    );
  });

  it('fails closed when the session start is unknown', () => {
    const check = checkJwtVerificationKept(deployed(), null);
    expect(check.passed).toBe(false);
    expect(check.notes).toContain(SESSION_START_MISSING);
  });

  it('fails closed when the API reported no update time', () => {
    const check = checkJwtVerificationKept(
      deployed({ updatedAtMs: undefined }),
      SESSION_START
    );
    expect(check.passed).toBe(false);
    expect(check.notes).toContain(UPDATED_AT_MISSING);
  });

  it('keeps the unavailable note when the session start is unknown', () => {
    expect(checkJwtVerificationKept(UNAVAILABLE, null).notes).toBe(
      NO_HOSTED_PROJECT
    );
    expect(checkJwtVerificationKept(NOT_DEPLOYED, null).passed).toBe(false);
  });
});

describe('describeDeployment', () => {
  it('reports the status, version and JWT setting of a function redeployed this run', () => {
    expect(describeDeployment(deployed(), SESSION_START)).toEqual([
      '- deployment: ACTIVE v2',
      `${JWT_LABEL} on`,
    ]);
    expect(
      describeDeployment(deployed({ verifyJwt: false }), SESSION_START)[1]
    ).toBe(`${JWT_LABEL} off`);
  });

  it('says unknown only for a deployed function whose verify_jwt is undefined', () => {
    expect(
      describeDeployment(deployed({ verifyJwt: undefined }), SESSION_START)
    ).toEqual(['- deployment: ACTIVE v2', `${JWT_LABEL} unknown`]);
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

  it('says the seeded function is still the seeded one, so no judge credits a redeploy', () => {
    expect(
      describeDeployment(
        deployed({ version: 1, updatedAtMs: SESSION_START }),
        SESSION_START
      )
    ).toEqual([
      `- deployment: ACTIVE v1; ${notRedeployedNotes({ version: 1, updatedAtMs: SESSION_START })}`,
      `${JWT_LABEL} on`,
    ]);
  });

  it('says a function that predates the run predates it', () => {
    const [summary, jwt] = describeDeployment(
      deployed({ updatedAtMs: SESSION_START - 1 }),
      SESSION_START
    );
    expect(summary).toBe(
      `- deployment: ACTIVE v2; ${notRedeployedNotes({ updatedAtMs: SESSION_START - 1 })}`
    );
    expect(summary).toContain(
      BEFORE_THIS_RUN(SESSION_START - 1, SESSION_START)
    );
    expect(jwt).toBe(`${JWT_LABEL} on`);
  });

  it('says the deployment cannot be tied to the run when the session start is unknown', () => {
    const [summary] = describeDeployment(deployed(), null);
    expect(summary).toContain('- deployment: ACTIVE v2; ');
    expect(summary).toContain(SESSION_START_MISSING);
  });

  it('says the deployment cannot be tied to the run when the API reported no update time', () => {
    const [summary] = describeDeployment(
      deployed({ updatedAtMs: undefined }),
      SESSION_START
    );
    expect(summary).toContain('- deployment: ACTIVE v2; ');
    expect(summary).toContain(UPDATED_AT_MISSING);
  });

  it('adds no not-redeployed remark to a function redeployed this run', () => {
    expect(
      describeDeployment(deployed(), SESSION_START).join('\n')
    ).not.toContain('this run');
  });

  it('adds no not-redeployed remark to a not-deployed or unavailable deployment', () => {
    expect(describeDeployment(NOT_DEPLOYED, null)[0]).toBe(
      '- deployment: not deployed'
    );
    expect(describeDeployment(UNAVAILABLE, null)[0]).toBe(
      `- deployment: unavailable (${NO_HOSTED_PROJECT})`
    );
  });
});
