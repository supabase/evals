// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-functions-004-download-edit-redeploy
import type {
  EdgeFunctionsInvokeInput,
  EdgeFunctionsInvokeResult,
} from '@supabase-evals/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type DeploymentProbe,
  judgeRedeploy,
  NO_HOSTED_PROJECT,
} from './hosted.js';
import {
  checkLowercaseCodesApply,
  checkOtherRulesKept,
  type ProbeOutcome,
  probePromos,
  type ResponsesProbe,
} from './responses.js';
import { PROMO_PROBES, type PromoProbe } from './seed.js';

const REF = 'abcdefghijklmnopqrst';
const ANON = 'anon-key-value';
const API_KEYS_PATH = '/v1/projects/{ref}/api-keys';

const SESSION_START = 1_700_000_000_000;
const REDEPLOYED_AT = SESSION_START + 60_000;

const ALL_TRUE = [true, true, true, true, true, true, true];
const ALL_FALSE = [false, false, false, false, false, false, false];
const PASSING = PROMO_PROBES.map(() => true);

const FIX = [0, 1, 2];
const KEPT_VALID = [3];
const KEPT_REJECTED = [4, 5, 6];

const SETTLE_DELAYS = [2000, 3000, 5000];
const ROUNDS = SETTLE_DELAYS.length + 1;

type Promo = { percentOff?: number; centsOff?: number; minCartCents?: number };

const PROMOS = new Map<string, Promo>([
  ['WELCOME10', { percentOff: 10 }],
  ['FREESHIP', { centsOff: 495, minCartCents: 3000 }],
  ['LOYAL15', { percentOff: 15, minCartCents: 4000 }],
]);

const deploymentOf = (
  overrides: Partial<{
    version: number | undefined;
    updatedAtMs: number | undefined;
  }> = {}
): DeploymentProbe => ({
  ok: true,
  deployed: {
    status: 'ACTIVE',
    verifyJwt: true,
    version: 2,
    updatedAtMs: REDEPLOYED_AT,
    ...overrides,
  },
});

type Key = { name: string; api_key?: string; type?: string };

const KEYS: Key[] = [
  { name: 'anon', api_key: ANON, type: 'legacy' },
  { name: 'service_role', api_key: 'service-role-key-value', type: 'legacy' },
];

const reply = (status: number, body: string): EdgeFunctionsInvokeResult => ({
  type: 'response',
  status,
  headers: {},
  body,
  outboundBearerTokens: [],
});

type PromoRequest = { code: string; cartCents: number };

const requestOf = (input: EdgeFunctionsInvokeInput) =>
  input.body as PromoRequest;

const labelOf = ({ code, cartCents }: PromoRequest) => `${code} @${cartCents}`;

function promoReply(
  input: EdgeFunctionsInvokeInput,
  { caseInsensitive }: { caseInsensitive: boolean }
) {
  const { code, cartCents } = requestOf(input);
  const promo = PROMOS.get(caseInsensitive ? code.toUpperCase() : code);
  if (
    !promo ||
    (promo.minCartCents !== undefined && cartCents < promo.minCartCents)
  ) {
    return reply(200, JSON.stringify({ valid: false, reason: 'not a code' }));
  }
  const discountCents =
    promo.percentOff !== undefined
      ? Math.round((cartCents * promo.percentOff) / 100)
      : Math.min(promo.centsOff ?? 0, cartCents);
  return reply(
    200,
    JSON.stringify({
      valid: true,
      code,
      discountCents,
      totalCents: cartCents - discountCents,
    })
  );
}

const fixedReply = (input: EdgeFunctionsInvokeInput) =>
  promoReply(input, { caseInsensitive: true });

const seededReply = (input: EdgeFunctionsInvokeInput) =>
  promoReply(input, { caseInsensitive: false });

type Invoke = (
  input: EdgeFunctionsInvokeInput
) => Promise<EdgeFunctionsInvokeResult>;

function fakeCtx(
  options: {
    invoke?: Invoke | null;
    keys?: Key[];
    keysError?: { status: number; body: unknown };
    keysThrow?: string;
  } = {}
) {
  const invoke = vi.fn<Invoke>(
    options.invoke ?? (async (input) => fixedReply(input))
  );
  const GET = vi.fn(async (path: string, _opts?: unknown) => {
    if (path !== API_KEYS_PATH) throw new Error(`unexpected GET ${path}`);
    if (options.keysThrow !== undefined) throw new Error(options.keysThrow);
    if (options.keysError) {
      return {
        data: undefined,
        error: options.keysError.body,
        response: { status: options.keysError.status },
      };
    }
    return {
      data: options.keys ?? KEYS,
      error: undefined,
      response: { status: 200 },
    };
  });
  return {
    GET,
    invoke,
    ctx: {
      hostedRef: REF,
      hostedMgmt: { GET } as never,
      ...(options.invoke === null ? {} : { invokeHostedFunction: invoke }),
    },
  };
}

type ProbeCtx = Parameters<typeof probePromos>[0];
type ProbeOptions = Parameters<typeof probePromos>[1];

const noSleep = () => vi.fn(async (_ms: number) => {});

const run = (ctx: ProbeCtx, overrides: Partial<ProbeOptions> = {}) =>
  probePromos(ctx, {
    deployment: deploymentOf(),
    sessionStartMs: SESSION_START,
    sleep: noSleep(),
    ...overrides,
  });

const outcomesOf = (probe: ResponsesProbe): ProbeOutcome[] => {
  if (!probe.ok) throw new Error(`probe failed: ${probe.notes}`);
  return probe.outcomes;
};

const passedOf = (probe: ResponsesProbe) =>
  outcomesOf(probe).map(({ passed }) => passed);

const respondTo =
  (answers: Record<string, EdgeFunctionsInvokeResult>, otherwise: Invoke) =>
  async (input: EdgeFunctionsInvokeInput) =>
    answers[labelOf(requestOf(input))] ?? otherwise(input);

const everything =
  (result: EdgeFunctionsInvokeResult): Invoke =>
  async () =>
    result;

const delaysOf = (sleep: ReturnType<typeof noSleep>) =>
  sleep.mock.calls.map(([ms]) => ms);

const byRound = (
  answer: (
    round: number,
    input: EdgeFunctionsInvokeInput
  ) => EdgeFunctionsInvokeResult
): Invoke => {
  const asked: Record<string, number> = {};
  return async (input) => {
    const label = labelOf(requestOf(input));
    asked[label] = (asked[label] ?? 0) + 1;
    return answer(asked[label], input);
  };
};

const staleThroughRound = (lastStaleRound: number) =>
  byRound((round, input) =>
    round <= lastStaleRound ? seededReply(input) : fixedReply(input)
  );

const bodyOf = (result: EdgeFunctionsInvokeResult) =>
  result.type === 'response' ? JSON.parse(result.body) : {};

const withBody = (
  result: EdgeFunctionsInvokeResult,
  change: (body: Record<string, unknown>) => Record<string, unknown>
) =>
  result.type === 'response'
    ? reply(result.status, JSON.stringify(change(bodyOf(result))))
    : result;

describe('probePromos', () => {
  it('fails with NO_HOSTED_PROJECT and calls nothing without a hosted project', async () => {
    const { invoke, GET } = fakeCtx();
    expect(await run({ invokeHostedFunction: invoke })).toEqual({
      ok: false,
      notes: NO_HOSTED_PROJECT,
    });
    expect(await run({ hostedRef: REF, invokeHostedFunction: invoke })).toEqual(
      { ok: false, notes: NO_HOSTED_PROJECT }
    );
    expect(
      await run({ hostedMgmt: { GET } as never, invokeHostedFunction: invoke })
    ).toEqual({ ok: false, notes: NO_HOSTED_PROJECT });
    expect(GET).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails with the invoker note when the context cannot invoke a hosted function', async () => {
    const { ctx, invoke } = fakeCtx({ invoke: null });
    expect(await run(ctx)).toEqual({
      ok: false,
      notes: 'no hosted function invoker on the scoring context',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reports the missing hosted project ahead of the missing invoker', async () => {
    expect(await run({})).toEqual({ ok: false, notes: NO_HOSTED_PROJECT });
  });

  it('looks the anon key up on the project', async () => {
    const { ctx, GET } = fakeCtx();
    await run(ctx);
    expect(GET).toHaveBeenCalledWith(
      API_KEYS_PATH,
      expect.objectContaining({
        params: expect.objectContaining({ path: { ref: REF } }),
      })
    );
  });

  it('sends each probe as a POST to apply-promo with the anon key and the probe body, in table order', async () => {
    const { ctx, invoke } = fakeCtx();
    await run(ctx);
    expect(invoke).toHaveBeenCalledTimes(PROMO_PROBES.length);
    PROMO_PROBES.forEach((probe, i) => {
      expect(invoke.mock.calls[i][0]).toMatchObject({
        name: 'apply-promo',
        method: 'POST',
        headers: {
          authorization: `Bearer ${ANON}`,
          apikey: ANON,
          'content-type': 'application/json',
        },
        body: probe.request,
      });
    });
  });

  it('sends the lowercase codes as the agent customers would type them', async () => {
    const { ctx, invoke } = fakeCtx();
    await run(ctx);
    expect(invoke.mock.calls.map(([input]) => input.body)).toEqual([
      { code: 'welcome10', cartCents: 6000 },
      { code: 'freeship', cartCents: 6000 },
      { code: 'loyal15', cartCents: 6000 },
      { code: 'LOYAL15', cartCents: 6000 },
      { code: 'FREESHIP', cartCents: 2000 },
      { code: 'LOYAL15', cartCents: 3000 },
      { code: 'SPRING50', cartCents: 6000 },
    ]);
  });

  it('never presents the service role key', async () => {
    const { ctx, invoke } = fakeCtx();
    await run(ctx);
    for (const [input] of invoke.mock.calls) {
      expect(JSON.stringify(input)).not.toContain('service-role-key-value');
    }
  });

  it('sends the anon key on both headers, wherever it sits, and not the publishable key when the project has both', async () => {
    const { ctx, invoke } = fakeCtx({
      keys: [
        {
          name: 'publishable',
          api_key: 'sb_publishable_x',
          type: 'publishable',
        },
        ...KEYS,
      ],
    });
    await run(ctx);
    expect(invoke).toHaveBeenCalledTimes(PROMO_PROBES.length);
    for (const [input] of invoke.mock.calls) {
      expect(input.headers).toMatchObject({
        authorization: `Bearer ${ANON}`,
        apikey: ANON,
      });
      expect(JSON.stringify(input)).not.toContain('sb_publishable_x');
    }
  });

  it('falls back to the publishable key on both headers for a publishable-only project', async () => {
    const { ctx, invoke } = fakeCtx({
      keys: [
        { name: 'service_role', api_key: 'srv-role-value', type: 'legacy' },
        { name: 'default', api_key: 'sb_publishable_x', type: 'publishable' },
      ],
    });
    expect(passedOf(await run(ctx))).toEqual(PASSING);
    expect(invoke).toHaveBeenCalledTimes(PROMO_PROBES.length);
    for (const [input] of invoke.mock.calls) {
      expect(input.headers).toMatchObject({
        authorization: 'Bearer sb_publishable_x',
        apikey: 'sb_publishable_x',
        'content-type': 'application/json',
      });
    }
  });

  it('falls back to the publishable key when the anon key has no value', async () => {
    const { ctx, invoke } = fakeCtx({
      keys: [
        { name: 'anon', type: 'legacy' },
        { name: 'default', api_key: 'sb_publishable_x', type: 'publishable' },
      ],
    });
    await run(ctx);
    expect(invoke.mock.calls[0][0].headers?.apikey).toBe('sb_publishable_x');
  });

  it('picks the publishable key by its type, not its name, and never a secret key', async () => {
    const { ctx, invoke } = fakeCtx({
      keys: [
        { name: 'publishable', api_key: 'sb_secret_x', type: 'secret' },
        { name: 'default', api_key: 'sb_publishable_x', type: 'publishable' },
        ...KEYS,
      ],
    });
    await run(ctx);
    for (const [input] of invoke.mock.calls) {
      expect(JSON.stringify(input)).not.toContain('sb_secret_x');
      expect(JSON.stringify(input)).not.toContain('service-role-key-value');
    }
  });

  it.each([
    [
      'only secret and service role keys',
      [
        { name: 'service_role', api_key: 'srv-role-value', type: 'legacy' },
        { name: 'default', api_key: 'sb_secret_x', type: 'secret' },
      ],
    ],
    ['an anon key with no value', [{ name: 'anon', type: 'legacy' }]],
    ['a publishable key with no value', [{ name: 'd', type: 'publishable' }]],
    ['an empty key list', []],
  ])(
    'fails without invoking anything when the project has %s',
    async (_label, keys) => {
      const { ctx, invoke } = fakeCtx({ keys });
      expect(await run(ctx)).toEqual({
        ok: false,
        notes: 'no anon or publishable API key on the project',
      });
      expect(invoke).not.toHaveBeenCalled();
    }
  );

  it('fails with the error when the keys cannot be read', async () => {
    const { ctx, invoke } = fakeCtx({
      keysError: { status: 500, body: { message: 'keys unavailable' } },
    });
    const probe = await run(ctx);
    expect(probe.ok).toBe(false);
    expect(!probe.ok && probe.notes).toContain('keys unavailable');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails with the message when the key lookup throws, and never rejects', async () => {
    const { ctx, invoke } = fakeCtx({ keysThrow: 'connection reset' });
    const probe = await run(ctx);
    expect(probe.ok).toBe(false);
    expect(!probe.ok && probe.notes).toContain('connection reset');
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('probePromos judges the answers', () => {
  it('passes every probe when the lookup is case-insensitive and keeps the other rules', async () => {
    const { ctx } = fakeCtx();
    const outcomes = outcomesOf(await run(ctx));
    expect(outcomes.map((o) => o.group)).toEqual([
      'fix',
      'fix',
      'fix',
      'kept',
      'kept',
      'kept',
      'kept',
    ]);
    expect(outcomes.map((o) => o.request)).toEqual(
      PROMO_PROBES.map((probe) => probe.request)
    );
    expect(outcomes.map((o) => o.passed)).toEqual(ALL_TRUE);
    expect(outcomes[0].detail).toBe('discount 600');
    expect(outcomes[1].detail).toBe('discount 495');
    expect(outcomes[2].detail).toBe('discount 900');
    expect(outcomes[3].detail).toBe('discount 900');
    expect(outcomes[4].detail).toBe('rejected');
    expect(outcomes[5].detail).toBe('rejected');
    expect(outcomes[6].detail).toBe('rejected');
  });

  it('fails only the three lowercase probes against the seeded, case-sensitive function, and the kept probes still reach it', async () => {
    const { ctx, invoke } = fakeCtx({
      invoke: async (input) => seededReply(input),
    });
    const outcomes = outcomesOf(await run(ctx));
    expect(outcomes.map((o) => o.passed)).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
      true,
    ]);
    expect(invoke).toHaveBeenCalledTimes(ROUNDS * PROMO_PROBES.length);
    expect(outcomes[0].detail).toContain('"valid":false');
  });

  it('accepts a function that adds fields to the answer', async () => {
    const { ctx } = fakeCtx({
      invoke: async (input) =>
        withBody(fixedReply(input), (body) => ({
          ...body,
          currency: 'USD',
          message: 'applied',
        })),
    });
    expect(passedOf(await run(ctx))).toEqual(PASSING);
  });

  it('accepts a rejected code answered with a 4xx status and a valid:false body', async () => {
    const { ctx } = fakeCtx({
      invoke: async (input) => {
        const answer = fixedReply(input);
        return answer.type === 'response' &&
          JSON.parse(answer.body).valid === false
          ? reply(422, answer.body)
          : answer;
      },
    });
    expect(passedOf(await run(ctx))).toEqual(PASSING);
  });

  it('fails a valid answer with the wrong discount and shows what it answered', async () => {
    const wrongDiscount = JSON.stringify({
      valid: true,
      code: 'welcome10',
      discountCents: 601,
      totalCents: 5399,
    });
    const { ctx } = fakeCtx({
      invoke: respondTo(
        { 'welcome10 @6000': reply(200, wrongDiscount) },
        async (input) => fixedReply(input)
      ),
    });
    const outcomes = outcomesOf(await run(ctx));
    expect(outcomes.map((o) => o.passed)).toEqual([
      false,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(outcomes[0].detail).toContain(`status 200: ${wrongDiscount}`);
  });

  it('fails a discount returned as a string and a valid flag returned as a string', async () => {
    const { ctx } = fakeCtx({
      invoke: respondTo(
        {
          'welcome10 @6000': reply(
            200,
            JSON.stringify({
              valid: true,
              code: 'welcome10',
              discountCents: '600',
              totalCents: 5400,
            })
          ),
          'freeship @6000': reply(
            200,
            JSON.stringify({
              valid: 'true',
              code: 'freeship',
              discountCents: 495,
              totalCents: 5505,
            })
          ),
        },
        async (input) => fixedReply(input)
      ),
    });
    expect((await run(ctx).then(passedOf)).slice(0, 2)).toEqual([false, false]);
  });

  it('fails a valid answer that omits the discount', async () => {
    const { ctx } = fakeCtx({
      invoke: respondTo(
        {
          'welcome10 @6000': reply(
            200,
            JSON.stringify({
              valid: true,
              code: 'welcome10',
              totalCents: 5400,
            })
          ),
        },
        async (input) => fixedReply(input)
      ),
    });
    expect((await run(ctx).then(passedOf))[0]).toBe(false);
  });

  it('fails a valid answer that is not a 200', async () => {
    const { ctx } = fakeCtx({
      invoke: async (input) => {
        const answer = fixedReply(input);
        return answer.type === 'response' ? { ...answer, status: 201 } : answer;
      },
    });
    const outcomes = outcomesOf(await run(ctx));
    expect(outcomes.slice(0, 4).map((o) => o.passed)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(outcomes[0].detail).toContain('201');
  });

  it('fails an accept-everything stub on every probe except the one whose 10 percent discount it happens to match', async () => {
    const { ctx } = fakeCtx({
      invoke: async (input) => {
        const { code, cartCents } = requestOf(input);
        const discountCents = Math.round(cartCents / 10);
        return reply(
          200,
          JSON.stringify({
            valid: true,
            code,
            discountCents,
            totalCents: cartCents - discountCents,
          })
        );
      },
    });
    expect(passedOf(await run(ctx))).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('fails a rewrite that forgot the loyalty code and the minimum cart', async () => {
    const { ctx } = fakeCtx({
      invoke: async (input) => {
        const { code, cartCents } = requestOf(input);
        const upper = code.toUpperCase();
        if (upper === 'WELCOME10') {
          return reply(
            200,
            JSON.stringify({
              valid: true,
              code,
              discountCents: cartCents / 10,
              totalCents: cartCents - cartCents / 10,
            })
          );
        }
        if (upper === 'FREESHIP') {
          return reply(
            200,
            JSON.stringify({
              valid: true,
              code,
              discountCents: 495,
              totalCents: cartCents - 495,
            })
          );
        }
        return reply(
          200,
          JSON.stringify({ valid: false, reason: 'not a code' })
        );
      },
    });
    expect(passedOf(await run(ctx))).toEqual([
      true,
      true,
      false,
      false,
      false,
      true,
      true,
    ]);
  });

  it('judges each probe on its own, so one wrong answer does not hide the others', async () => {
    const { ctx } = fakeCtx({
      invoke: respondTo(
        {
          'LOYAL15 @6000': reply(
            200,
            JSON.stringify({ valid: false, reason: 'not a code' })
          ),
        },
        async (input) => fixedReply(input)
      ),
    });
    expect(passedOf(await run(ctx))).toEqual([
      true,
      true,
      true,
      false,
      true,
      true,
      true,
    ]);
  });

  it('keeps probing when one invocation throws and records the message', async () => {
    const { ctx, invoke } = fakeCtx({
      invoke: async (input) => {
        if (labelOf(requestOf(input)) === 'welcome10 @6000') {
          throw new Error('socket hang up');
        }
        return fixedReply(input);
      },
    });
    const outcomes = outcomesOf(await run(ctx));
    expect(invoke).toHaveBeenCalledTimes(PROMO_PROBES.length);
    expect(outcomes.map((o) => o.passed)).toEqual([
      false,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(outcomes[0].detail).toContain('socket hang up');
  });
});

describe('probePromos never reads an unreachable function as a rejected code', () => {
  const UNREACHABLE: [string, EdgeFunctionsInvokeResult][] = [
    ['a 401', reply(401, '{"error":"Missing authorization header"}')],
    ['a 403', reply(403, '{"error":"forbidden"}')],
    ['a 404', reply(404, '{"message":"Function not found"}')],
    ['a 400 with an error body', reply(400, '{"error":"Body must be JSON"}')],
    ['a 200 error body without a valid flag', reply(200, '{"error":"nope"}')],
    [
      'a 500 that claims valid:false',
      reply(500, '{"valid":false,"reason":"unknown code"}'),
    ],
    ['a hello-world 200', reply(200, 'Hello from the starter function')],
    ['an empty 200', reply(200, '')],
    ['a 200 with the string "false"', reply(200, '"false"')],
    ['a 200 with null', reply(200, 'null')],
    ['a 200 with valid as the string "false"', reply(200, '{"valid":"false"}')],
    ['an invoker error', { type: 'error', error: 'edge function not found' }],
  ];

  it.each(UNREACHABLE)(
    'fails all seven probes on %s, including the three that expect a rejection',
    async (_label, result) => {
      const { ctx } = fakeCtx({ invoke: everything(result) });
      expect(passedOf(await run(ctx))).toEqual(ALL_FALSE);
    }
  );

  it('fails the three rejection probes when the invocation throws', async () => {
    const { ctx } = fakeCtx({
      invoke: async () => {
        throw new Error('socket hang up');
      },
    });
    expect(passedOf(await run(ctx))).toEqual(ALL_FALSE);
  });

  it('counts a rejection only when the body says valid:false', async () => {
    const { ctx } = fakeCtx({
      invoke: everything(reply(200, '{"valid":false,"reason":"unknown code"}')),
    });
    const outcomes = outcomesOf(await run(ctx));
    expect(outcomes.map((o) => o.passed)).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
  });

  it('shows the status and the body of a failing call', async () => {
    const { ctx } = fakeCtx({
      invoke: everything(
        reply(401, '{"error":"Missing authorization header"}')
      ),
    });
    const [first] = outcomesOf(await run(ctx));
    expect(first.detail).toContain('status 401');
    expect(first.detail).toContain('Missing authorization header');
  });

  it('shows what a non-JSON answer said', async () => {
    const { ctx } = fakeCtx({
      invoke: everything(reply(200, 'Hello from the starter function')),
    });
    const [first] = outcomesOf(await run(ctx));
    expect(first.detail).toContain('Hello from the starter function');
  });

  it('names an invoker error', async () => {
    const { ctx } = fakeCtx({
      invoke: everything({ type: 'error', error: 'edge function not found' }),
    });
    const [first] = outcomesOf(await run(ctx));
    expect(first.detail).toContain('error: edge function not found');
  });

  it('truncates a long error body to 200 characters', async () => {
    const { ctx } = fakeCtx({
      invoke: everything(reply(500, 'x'.repeat(500))),
    });
    const [first] = outcomesOf(await run(ctx));
    expect(first.detail).toContain(`status 500: ${'x'.repeat(200)}...`);
    expect(first.detail).not.toContain('x'.repeat(201));
  });
});

describe('probePromos gate on the deployment', () => {
  const GATED: [string, Partial<ProbeOptions>][] = [
    [
      'a function that predates the run',
      { deployment: deploymentOf({ updatedAtMs: SESSION_START - 1 }) },
    ],
    [
      'the seeded version 1 updated after the session started',
      { deployment: deploymentOf({ version: 1 }) },
    ],
    [
      'the seeded version 1 that also predates the run',
      {
        deployment: deploymentOf({
          version: 1,
          updatedAtMs: SESSION_START - 1,
        }),
      },
    ],
    ['an unknown session start', { sessionStartMs: null }],
    [
      'a function with no update time',
      { deployment: deploymentOf({ updatedAtMs: undefined }) },
    ],
  ];

  it.each(GATED)(
    'does not invoke %s and says why, with the judgeRedeploy notes',
    async (_label, overrides) => {
      const { ctx, invoke } = fakeCtx();
      const options = {
        deployment: deploymentOf(),
        sessionStartMs: SESSION_START as number | null,
        ...overrides,
      };
      const { deployment } = options;
      if (!deployment.ok || deployment.deployed === null) {
        throw new Error('gated cases deploy a function');
      }
      const verdict = judgeRedeploy(
        deployment.deployed,
        options.sessionStartMs
      );
      expect(verdict.redeployed).toBe(false);
      expect(await run(ctx, overrides)).toEqual({
        ok: false,
        notes: `not probed: ${verdict.redeployed ? '' : verdict.notes}`,
      });
      expect(invoke).not.toHaveBeenCalled();
    }
  );

  it('names the seeded version in the note for the untouched seed', async () => {
    const { ctx } = fakeCtx();
    const probe = await run(ctx, { deployment: deploymentOf({ version: 1 }) });
    expect(!probe.ok && probe.notes).toContain('seeded');
  });

  it('probes a function redeployed in the very millisecond the session started', async () => {
    const { ctx, invoke } = fakeCtx();
    const probe = await run(ctx, {
      deployment: deploymentOf({ updatedAtMs: SESSION_START }),
    });
    expect(probe.ok).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(PROMO_PROBES.length);
  });

  it('does not invoke when nothing is deployed and names the 404', async () => {
    const { ctx, invoke } = fakeCtx();
    expect(
      await run(ctx, {
        deployment: {
          ok: true,
          deployed: null,
          notFound: '404: Function not found',
        },
      })
    ).toEqual({
      ok: false,
      notes:
        'not probed: the project has no apply-promo function (404: Function not found)',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not invoke when nothing is deployed and the 404 carried no message', async () => {
    const { ctx, invoke } = fakeCtx();
    expect(
      await run(ctx, { deployment: { ok: true, deployed: null } })
    ).toEqual({
      ok: false,
      notes: 'not probed: the project has no apply-promo function',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not invoke when the deployment could not be read and names why', async () => {
    const { ctx, invoke } = fakeCtx();
    expect(
      await run(ctx, { deployment: { ok: false, notes: 'connection reset' } })
    ).toEqual({ ok: false, notes: 'not probed: connection reset' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('names the missing hosted project when there is no hosted project and nothing could be read', async () => {
    const probe = await run(
      {},
      {
        deployment: { ok: false, notes: NO_HOSTED_PROJECT },
        sessionStartMs: null,
      }
    );
    expect(probe.ok).toBe(false);
    expect(!probe.ok && probe.notes).toContain(NO_HOSTED_PROJECT);
  });
});

describe('probePromos retries a cold boot', () => {
  const scripted = (script: Record<string, EdgeFunctionsInvokeResult[]>) => {
    const attempts: Record<string, number> = {};
    const invoke: Invoke = async (input) => {
      const label = labelOf(requestOf(input));
      attempts[label] = (attempts[label] ?? 0) + 1;
      return script[label]?.[attempts[label] - 1] ?? fixedReply(input);
    };
    return invoke;
  };

  const callsFor = (
    invoke: { mock: { calls: [EdgeFunctionsInvokeInput][] } },
    label: string
  ) =>
    invoke.mock.calls.filter(([input]) => labelOf(requestOf(input)) === label)
      .length;

  const FIRST = 'welcome10 @6000';
  const REJECTED = 'SPRING50 @6000';
  const booting = (status = 503) =>
    Array.from({ length: 30 }, () => reply(status, '{"code":"BOOT_ERROR"}'));

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes a probe whose first call hit a 503 and whose retry answered', async () => {
    const sleep = noSleep();
    const { ctx, invoke } = fakeCtx({
      invoke: scripted({ [FIRST]: [reply(503, '{"code":"BOOT_ERROR"}')] }),
    });
    const outcomes = outcomesOf(await run(ctx, { sleep }));
    expect(outcomes.map((o) => o.passed)).toEqual(PASSING);
    expect(outcomes[0].detail).toBe('discount 600');
    expect(callsFor(invoke, FIRST)).toBe(2);
    expect(invoke).toHaveBeenCalledTimes(PROMO_PROBES.length + 1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it.each([502, 503, 504])('retries a %i', async (status) => {
    const { ctx, invoke } = fakeCtx({
      invoke: scripted({ [FIRST]: [reply(status, 'booting')] }),
    });
    expect(passedOf(await run(ctx))).toEqual(PASSING);
    expect(callsFor(invoke, FIRST)).toBe(2);
  });

  it('passes a probe that only answers on its third attempt', async () => {
    const sleep = noSleep();
    const { ctx, invoke } = fakeCtx({
      invoke: scripted({ [FIRST]: [reply(503, 'boot'), reply(503, 'boot')] }),
    });
    expect(passedOf(await run(ctx, { sleep }))).toEqual(PASSING);
    expect(callsFor(invoke, FIRST)).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('resends the same request on a retry', async () => {
    const { ctx, invoke } = fakeCtx({
      invoke: scripted({ [FIRST]: [reply(503, 'boot')] }),
    });
    await run(ctx);
    const [first, second] = invoke.mock.calls;
    expect(second[0]).toEqual(first[0]);
    expect(first[0].body).toEqual(PROMO_PROBES[0].request);
  });

  it('gives up after three attempts in each round and reports the last status and the attempt count', async () => {
    const { ctx, invoke } = fakeCtx({
      invoke: scripted({ [FIRST]: booting() }),
    });
    const outcomes = outcomesOf(await run(ctx));
    expect(outcomes[0].passed).toBe(false);
    expect(outcomes[0].detail).toContain('status 503: {"code":"BOOT_ERROR"}');
    expect(outcomes[0].detail).toContain('(after 3 attempts)');
    expect(callsFor(invoke, FIRST)).toBe(ROUNDS * 3);
  });

  it('does not read a probe that never stopped answering 503 as a rejected code', async () => {
    const { ctx } = fakeCtx({
      invoke: scripted({ [REJECTED]: booting() }),
    });
    const outcomes = outcomesOf(await run(ctx));
    const last = outcomes.at(-1);
    expect(last?.request).toEqual({ code: 'SPRING50', cartCents: 6000 });
    expect(last?.passed).toBe(false);
    expect(last?.detail).toContain('status 503: {"code":"BOOT_ERROR"}');
    expect(last?.detail).toContain('(after 3 attempts)');
  });

  it('retries each probe on its own attempts, so one cold function does not spend the others', async () => {
    const { ctx, invoke } = fakeCtx({
      invoke: scripted({ [FIRST]: booting(502) }),
    });
    const passed = passedOf(await run(ctx));
    expect(passed).toEqual([false, ...PASSING.slice(1)]);
    expect(callsFor(invoke, 'freeship @6000')).toBe(ROUNDS);
    expect(callsFor(invoke, 'SPRING50 @6000')).toBe(ROUNDS);
  });

  it('waits one second and then two between attempts, a settle delay between rounds, and never after the last attempt of the last round', async () => {
    const sleep = noSleep();
    const { ctx } = fakeCtx({ invoke: scripted({ [FIRST]: booting() }) });
    await run(ctx, { sleep });
    expect(delaysOf(sleep)).toEqual([
      1000, 2000, 2000, 1000, 2000, 3000, 1000, 2000, 5000, 1000, 2000,
    ]);
  });

  it('reports the last status when the status changes across attempts', async () => {
    const eachRound = Array.from({ length: ROUNDS }, () => [
      reply(503, 'boot'),
      reply(503, 'boot'),
      reply(500, 'boom'),
    ]).flat();
    const { ctx, invoke } = fakeCtx({
      invoke: scripted({ [FIRST]: eachRound }),
    });
    const outcomes = outcomesOf(await run(ctx));
    expect(outcomes[0].passed).toBe(false);
    expect(outcomes[0].detail).toContain('status 500: boom');
    expect(outcomes[0].detail).toContain('(after 3 attempts)');
    expect(callsFor(invoke, FIRST)).toBe(ROUNDS * 3);
  });

  it('stops at a non-retriable status that follows a 503', async () => {
    const eachRound = Array.from({ length: ROUNDS }, () => [
      reply(503, 'boot'),
      reply(401, 'denied'),
    ]).flat();
    const { ctx, invoke } = fakeCtx({
      invoke: scripted({ [FIRST]: eachRound }),
    });
    const outcomes = outcomesOf(await run(ctx));
    expect(outcomes[0].passed).toBe(false);
    expect(outcomes[0].detail).toContain('status 401: denied');
    expect(outcomes[0].detail).toContain('(after 2 attempts)');
    expect(callsFor(invoke, FIRST)).toBe(ROUNDS * 2);
  });

  it.each([401, 404, 429, 500, 501])(
    'does not retry a %i inside a round, only in the settle rounds',
    async (status) => {
      const sleep = noSleep();
      const { ctx, invoke } = fakeCtx({
        invoke: everything(reply(status, 'denied')),
      });
      const outcomes = outcomesOf(await run(ctx, { sleep }));
      for (const { detail } of outcomes) {
        expect(detail).toContain(`status ${status}: denied`);
        expect(detail).toContain('(after 4 rounds)');
        expect(detail).not.toContain('attempts');
      }
      expect(invoke).toHaveBeenCalledTimes(ROUNDS * PROMO_PROBES.length);
      expect(delaysOf(sleep)).toEqual(SETTLE_DELAYS);
    }
  );

  it('does not retry an invoker error result', async () => {
    const sleep = noSleep();
    const { ctx, invoke } = fakeCtx({
      invoke: everything({ type: 'error', error: 'edge function not found' }),
    });
    const outcomes = outcomesOf(await run(ctx, { sleep }));
    expect(outcomes[0].detail).toBe('error: edge function not found');
    expect(invoke).toHaveBeenCalledTimes(PROMO_PROBES.length);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry an invocation that throws', async () => {
    const sleep = noSleep();
    const { ctx, invoke } = fakeCtx({
      invoke: async () => {
        throw new Error('socket hang up');
      },
    });
    const outcomes = outcomesOf(await run(ctx, { sleep }));
    expect(outcomes[0].detail).toContain('socket hang up');
    expect(invoke).toHaveBeenCalledTimes(PROMO_PROBES.length);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry a 200 with the wrong answer inside a round, only in the settle rounds', async () => {
    const sleep = noSleep();
    const { ctx, invoke } = fakeCtx({
      invoke: everything(reply(200, 'Hello from the starter')),
    });
    await run(ctx, { sleep });
    expect(invoke).toHaveBeenCalledTimes(ROUNDS * PROMO_PROBES.length);
    expect(delaysOf(sleep)).toEqual(SETTLE_DELAYS);
  });

  it('waits on the clock between attempts when no sleep is injected', async () => {
    vi.useFakeTimers();
    const { ctx, invoke } = fakeCtx({
      invoke: scripted({ [FIRST]: [reply(503, 'boot')] }),
    });
    const pending = probePromos(ctx, {
      deployment: deploymentOf(),
      sessionStartMs: SESSION_START,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(passedOf(await pending)).toEqual(PASSING);
    expect(invoke).toHaveBeenCalledTimes(PROMO_PROBES.length + 1);
  });
});

describe('probePromos settles after a redeploy that is briefly served stale', () => {
  it('waits 2 seconds and re-runs every probe once when the first round hit the stale code, then passes', async () => {
    const sleep = noSleep();
    const { ctx, invoke } = fakeCtx({ invoke: staleThroughRound(1) });
    const probe = await run(ctx, { sleep });
    expect(passedOf(probe)).toEqual(PASSING);
    expect(checkLowercaseCodesApply(probe).passed).toBe(true);
    expect(checkOtherRulesKept(probe).passed).toBe(true);
    expect(delaysOf(sleep)).toEqual([2000]);
    expect(invoke).toHaveBeenCalledTimes(2 * PROMO_PROBES.length);
    expect(
      invoke.mock.calls.map(([input]) => labelOf(requestOf(input)))
    ).toEqual([
      ...PROMO_PROBES.map(({ request }) => labelOf(request)),
      ...PROMO_PROBES.map(({ request }) => labelOf(request)),
    ]);
  });

  it('keeps the passing detail of a probe that settled in a later round', async () => {
    const { ctx } = fakeCtx({ invoke: staleThroughRound(1) });
    const outcomes = outcomesOf(await run(ctx));
    expect(outcomes[0].detail).toContain('discount 600');
    expect(outcomes[1].detail).toContain('discount 495');
    expect(outcomes[2].detail).toContain('discount 900');
  });

  it('stops as soon as a round passes every probe and never sleeps after it', async () => {
    const sleep = noSleep();
    const { ctx, invoke } = fakeCtx({ invoke: staleThroughRound(2) });
    expect(passedOf(await run(ctx, { sleep }))).toEqual(PASSING);
    expect(delaysOf(sleep)).toEqual([2000, 3000]);
    expect(invoke).toHaveBeenCalledTimes(3 * PROMO_PROBES.length);
  });

  it('passes on the last settle round when the stale code is served for three rounds', async () => {
    const sleep = noSleep();
    const { ctx, invoke } = fakeCtx({ invoke: staleThroughRound(3) });
    expect(passedOf(await run(ctx, { sleep }))).toEqual(PASSING);
    expect(delaysOf(sleep)).toEqual(SETTLE_DELAYS);
    expect(invoke).toHaveBeenCalledTimes(ROUNDS * PROMO_PROBES.length);
  });

  it('gives up after three settle rounds, 10 seconds of waiting, when the stale code never clears', async () => {
    const sleep = noSleep();
    const { ctx, invoke } = fakeCtx({ invoke: staleThroughRound(Infinity) });
    const probe = await run(ctx, { sleep });
    expect(passedOf(probe)).toEqual([false, false, false, ...PASSING.slice(3)]);
    expect(delaysOf(sleep)).toEqual([2000, 3000, 5000]);
    expect(delaysOf(sleep).reduce((total, ms) => total + ms, 0)).toBe(10_000);
    expect(invoke).toHaveBeenCalledTimes(ROUNDS * PROMO_PROBES.length);
    expect(checkLowercaseCodesApply(probe).passed).toBe(false);
    expect(checkOtherRulesKept(probe).passed).toBe(true);
  });

  it('says how many rounds ran on every probe that still failed, and in the lowercase check notes', async () => {
    const { ctx } = fakeCtx({ invoke: staleThroughRound(Infinity) });
    const probe = await run(ctx);
    for (const outcome of outcomesOf(probe).slice(0, 3)) {
      expect(outcome.detail).toContain('"valid":false');
      expect(outcome.detail).toContain('(after 4 rounds)');
    }
    const lines = checkLowercaseCodesApply(probe).notes?.split('; ') ?? [];
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).toContain('(after 4 rounds)');
  });

  it('does not run a settle round for a function that answers every probe correctly', async () => {
    const sleep = noSleep();
    const { ctx, invoke } = fakeCtx();
    const outcomes = outcomesOf(await run(ctx, { sleep }));
    expect(sleep).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(PROMO_PROBES.length);
    for (const { detail } of outcomes) expect(detail).not.toContain('rounds');
  });

  it('does not run a settle round when the only failure is an invoker error', async () => {
    const sleep = noSleep();
    const { ctx, invoke } = fakeCtx({
      invoke: respondTo(
        {
          'freeship @6000': { type: 'error', error: 'edge function not found' },
        },
        async (input) => fixedReply(input)
      ),
    });
    const outcomes = outcomesOf(await run(ctx, { sleep }));
    expect(outcomes.map((o) => o.passed)).toEqual([
      true,
      false,
      ...PASSING.slice(2),
    ]);
    expect(outcomes[1].detail).toBe('error: edge function not found');
    expect(sleep).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(PROMO_PROBES.length);
  });

  it('does not run a settle round when the only failure is a thrown error', async () => {
    const sleep = noSleep();
    const { ctx, invoke } = fakeCtx({
      invoke: async (input) => {
        if (labelOf(requestOf(input)) === 'freeship @6000') {
          throw new Error('socket hang up');
        }
        return fixedReply(input);
      },
    });
    const outcomes = outcomesOf(await run(ctx, { sleep }));
    expect(outcomes[1]).toMatchObject({
      passed: false,
      detail: 'error: socket hang up',
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(PROMO_PROBES.length);
  });

  it('runs a settle round when an HTTP answer failed in the same round as an invoker error', async () => {
    const sleep = noSleep();
    const { ctx, invoke } = fakeCtx({
      invoke: byRound((round, input) => {
        const label = labelOf(requestOf(input));
        if (round === 1 && label === 'freeship @6000') {
          return { type: 'error', error: 'edge function not found' };
        }
        return round === 1 ? seededReply(input) : fixedReply(input);
      }),
    });
    expect(passedOf(await run(ctx, { sleep }))).toEqual(PASSING);
    expect(delaysOf(sleep)).toEqual([2000]);
    expect(invoke).toHaveBeenCalledTimes(2 * PROMO_PROBES.length);
  });

  it('reports the last round, not the best answer each probe gave', async () => {
    const { ctx } = fakeCtx({
      invoke: byRound((round, input) => {
        const label = labelOf(requestOf(input));
        if (label === 'welcome10 @6000' && round === 1) {
          return seededReply(input);
        }
        if (label === 'LOYAL15 @6000' && round > 1) {
          return reply(
            200,
            JSON.stringify({ valid: false, reason: 'not a code' })
          );
        }
        return fixedReply(input);
      }),
    });
    expect(passedOf(await run(ctx))).toEqual([
      true,
      true,
      true,
      false,
      ...PASSING.slice(4),
    ]);
  });

  it('still retries a 503 inside a settle round', async () => {
    const sleep = noSleep();
    const { ctx, invoke } = fakeCtx({
      invoke: byRound((round, input) => {
        const label = labelOf(requestOf(input));
        if (label !== 'welcome10 @6000') return fixedReply(input);
        if (round === 1) return seededReply(input);
        return round === 2
          ? reply(503, '{"code":"BOOT_ERROR"}')
          : fixedReply(input);
      }),
    });
    expect(passedOf(await run(ctx, { sleep }))).toEqual(PASSING);
    expect(delaysOf(sleep)).toEqual([2000, 1000]);
    expect(invoke).toHaveBeenCalledTimes(2 * PROMO_PROBES.length + 1);
  });

  it('waits on the clock for each settle round when no sleep is injected', async () => {
    vi.useFakeTimers();
    try {
      const { ctx, invoke } = fakeCtx({ invoke: staleThroughRound(1) });
      const pending = probePromos(ctx, {
        deployment: deploymentOf(),
        sessionStartMs: SESSION_START,
      });
      await vi.advanceTimersByTimeAsync(1999);
      expect(invoke).toHaveBeenCalledTimes(PROMO_PROBES.length);
      await vi.advanceTimersByTimeAsync(1);
      expect(passedOf(await pending)).toEqual(PASSING);
      expect(invoke).toHaveBeenCalledTimes(2 * PROMO_PROBES.length);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('probePromos judges the whole response shape', () => {
  const FIRST = 'welcome10 @6000';

  const answerFirstWith = (body: unknown) =>
    fakeCtx({
      invoke: respondTo(
        { [FIRST]: reply(200, JSON.stringify(body)) },
        async (input) => fixedReply(input)
      ),
    }).ctx;

  const WELCOME = {
    valid: true,
    code: 'welcome10',
    discountCents: 600,
    totalCents: 5400,
  };

  it.each([
    ['totalCents is missing', { ...WELCOME, totalCents: undefined }],
    ['totalCents is wrong', { ...WELCOME, totalCents: 5000 }],
    ['totalCents ignores the discount', { ...WELCOME, totalCents: 6000 }],
    ['totalCents is a string', { ...WELCOME, totalCents: '5400' }],
    ['code is missing', { ...WELCOME, code: undefined }],
    ['code is null', { ...WELCOME, code: null }],
    ['code is a number', { ...WELCOME, code: 10 }],
    ['code is empty', { ...WELCOME, code: '' }],
    ['code names a different promo', { ...WELCOME, code: 'FREESHIP' }],
    ['code is a near miss of the promo', { ...WELCOME, code: 'welcome20' }],
  ])('fails a valid answer when %s', async (_label, body) => {
    const outcomes = outcomesOf(await run(answerFirstWith(body)));
    expect(outcomes.map((o) => o.passed)).toEqual([false, ...PASSING.slice(1)]);
    expect(outcomes[0].detail).toContain('status 200:');
  });

  it.each([
    ['the code echoed in uppercase', { ...WELCOME, code: 'WELCOME10' }],
    ['the code echoed as sent', WELCOME],
    ['extra fields', { ...WELCOME, currency: 'USD', message: 'applied' }],
  ])('passes a valid answer with %s', async (_label, body) => {
    const outcomes = outcomesOf(await run(answerFirstWith(body)));
    expect(outcomes.map((o) => o.passed)).toEqual(PASSING);
    expect(outcomes[0].detail).toBe('discount 600');
  });

  it('passes a function that echoes every code in uppercase', async () => {
    const { ctx } = fakeCtx({
      invoke: async (input) =>
        withBody(fixedReply(input), (body) =>
          typeof body.code === 'string'
            ? { ...body, code: body.code.toUpperCase() }
            : body
        ),
    });
    expect(passedOf(await run(ctx))).toEqual(PASSING);
  });

  it('passes a function that echoes every code in lowercase', async () => {
    const { ctx } = fakeCtx({
      invoke: async (input) =>
        withBody(fixedReply(input), (body) =>
          typeof body.code === 'string'
            ? { ...body, code: body.code.toLowerCase() }
            : body
        ),
    });
    expect(passedOf(await run(ctx))).toEqual(PASSING);
  });

  it('computes the expected total from each probe own cart and discount', async () => {
    const { ctx } = fakeCtx({
      invoke: async (input) =>
        withBody(fixedReply(input), (body) =>
          body.valid === true ? { ...body, totalCents: 5400 } : body
        ),
    });
    expect(passedOf(await run(ctx))).toEqual([
      true,
      false,
      false,
      false,
      ...PASSING.slice(4),
    ]);
  });

  it.each([
    ['has no reason', { valid: false }],
    ['has an empty reason', { valid: false, reason: '' }],
    ['has a null reason', { valid: false, reason: null }],
    ['has a numeric reason', { valid: false, reason: 42 }],
  ])('fails a rejection that %s', async (_label, body) => {
    const { ctx } = fakeCtx({
      invoke: everything(reply(200, JSON.stringify(body))),
    });
    const outcomes = outcomesOf(await run(ctx));
    const rejections = outcomes.slice(4);
    expect(rejections.length).toBeGreaterThan(0);
    expect(rejections.map((o) => o.passed)).toEqual(
      rejections.map(() => false)
    );
    expect(outcomes[4].detail).toContain('status 200:');
  });

  it('fails a rejection with a reason when the status is 500', async () => {
    const { ctx } = fakeCtx({
      invoke: everything(
        reply(500, JSON.stringify({ valid: false, reason: 'unknown code' }))
      ),
    });
    const rejections = outcomesOf(await run(ctx)).slice(4);
    expect(rejections.map((o) => o.passed)).toEqual(
      rejections.map(() => false)
    );
  });

  it('passes a rejection with a reason and a 4xx status', async () => {
    const { ctx } = fakeCtx({
      invoke: everything(
        reply(409, JSON.stringify({ valid: false, reason: 'below minimum' }))
      ),
    });
    const rejections = outcomesOf(await run(ctx)).slice(4);
    expect(rejections.map((o) => o.passed)).toEqual(rejections.map(() => true));
  });
});

const PROBES: Pick<PromoProbe, 'group' | 'request'>[] = [
  { group: 'fix', request: { code: 'welcome10', cartCents: 6000 } },
  { group: 'fix', request: { code: 'freeship', cartCents: 6000 } },
  { group: 'fix', request: { code: 'loyal15', cartCents: 6000 } },
  { group: 'kept', request: { code: 'LOYAL15', cartCents: 6000 } },
  { group: 'kept', request: { code: 'FREESHIP', cartCents: 2000 } },
  { group: 'kept', request: { code: 'LOYAL15', cartCents: 3000 } },
  { group: 'kept', request: { code: 'SPRING50', cartCents: 6000 } },
];

const outcome = (
  index: number,
  passed: boolean,
  detail: string
): ProbeOutcome => ({ ...PROBES[index], passed, detail });

const ALL_PASSED: ProbeOutcome[] = [
  outcome(0, true, 'discount 600'),
  outcome(1, true, 'discount 495'),
  outcome(2, true, 'discount 900'),
  outcome(3, true, 'discount 900'),
  outcome(4, true, 'rejected'),
  outcome(5, true, 'rejected'),
  outcome(6, true, 'rejected'),
];

const withFailure = (index: number, detail: string): ResponsesProbe => ({
  ok: true,
  outcomes: ALL_PASSED.map((o, i) =>
    i === index ? { ...o, passed: false, detail } : o
  ),
});

describe('checkLowercaseCodesApply', () => {
  const name = 'lowercase promo codes now apply on the live function';

  it('passes when every lowercase probe passed and lists each', () => {
    const check = checkLowercaseCodesApply({ ok: true, outcomes: ALL_PASSED });
    expect(check).toMatchObject({ name, passed: true });
    expect(check.notes).toContain('welcome10 @6000: discount 600');
    expect(check.notes).toContain('freeship @6000: discount 495');
    expect(check.notes).toContain('loyal15 @6000: discount 900');
  });

  it.each(FIX)(
    'fails when fix probe %i failed, and shows what it came back with',
    (index) => {
      const { code, cartCents } = PROMO_PROBES[index].request;
      const check = checkLowercaseCodesApply(
        withFailure(index, 'status 200: {"valid":false}')
      );
      expect(check.passed).toBe(false);
      expect(check.notes).toContain(
        `${code} @${cartCents}: status 200: {"valid":false}`
      );
    }
  );

  it.each([...KEPT_VALID, ...KEPT_REJECTED])(
    'does not fail on kept probe %i, which belongs to the other check',
    (index) => {
      expect(
        checkLowercaseCodesApply(withFailure(index, 'status 401: denied'))
          .passed
      ).toBe(true);
    }
  );

  it('never passes without a fix outcome', () => {
    expect(checkLowercaseCodesApply({ ok: true, outcomes: [] }).passed).toBe(
      false
    );
    expect(
      checkLowercaseCodesApply({ ok: true, outcomes: ALL_PASSED.slice(3) })
        .passed
    ).toBe(false);
  });

  it('fails with the probe notes when the probe could not run', () => {
    expect(
      checkLowercaseCodesApply({ ok: false, notes: NO_HOSTED_PROJECT })
    ).toEqual({ name, passed: false, notes: NO_HOSTED_PROJECT });
  });

  it('fails with the not-probed notes when the function was not redeployed', () => {
    expect(
      checkLowercaseCodesApply({
        ok: false,
        notes: 'not probed: still the seeded deployment (version 1)',
      })
    ).toEqual({
      name,
      passed: false,
      notes: 'not probed: still the seeded deployment (version 1)',
    });
  });
});

describe('checkOtherRulesKept', () => {
  const name = 'the live function keeps its other promo rules';

  it('passes when every kept probe passed and lists each', () => {
    const check = checkOtherRulesKept({ ok: true, outcomes: ALL_PASSED });
    expect(check).toMatchObject({ name, passed: true });
    expect(check.notes).toContain('LOYAL15 @6000: discount 900');
    expect(check.notes).toContain('FREESHIP @2000:');
    expect(check.notes).toContain('LOYAL15 @3000:');
    expect(check.notes).toContain('SPRING50 @6000:');
  });

  it.each([...KEPT_VALID, ...KEPT_REJECTED])(
    'fails when kept probe %i failed, and still lists every kept probe',
    (index) => {
      const check = checkOtherRulesKept(
        withFailure(index, 'status 401: denied')
      );
      expect(check.passed).toBe(false);
      expect(check.notes).toContain('status 401: denied');
      expect(check.notes).toContain('LOYAL15 @6000:');
      expect(check.notes).toContain('FREESHIP @2000:');
      expect(check.notes).toContain('LOYAL15 @3000:');
      expect(check.notes).toContain('SPRING50 @6000:');
    }
  );

  it.each(FIX)(
    'does not fail on fix probe %i, which belongs to the other check',
    (index) => {
      expect(
        checkOtherRulesKept(withFailure(index, 'status 401: denied')).passed
      ).toBe(true);
    }
  );

  it('does not list the fix probes', () => {
    const check = checkOtherRulesKept({ ok: true, outcomes: ALL_PASSED });
    expect(check.notes).not.toContain('welcome10');
    expect(check.notes).not.toContain('freeship @6000');
    expect(check.notes).not.toContain('loyal15 @6000');
  });

  it('never passes without a kept outcome', () => {
    expect(checkOtherRulesKept({ ok: true, outcomes: [] }).passed).toBe(false);
    expect(
      checkOtherRulesKept({ ok: true, outcomes: ALL_PASSED.slice(0, 3) }).passed
    ).toBe(false);
  });

  it('fails with the probe notes when the probe could not run', () => {
    expect(
      checkOtherRulesKept({ ok: false, notes: NO_HOSTED_PROJECT })
    ).toEqual({ name, passed: false, notes: NO_HOSTED_PROJECT });
  });
});
