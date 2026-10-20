// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-functions-002-deploy-and-call
import type {
  EdgeFunctionsInvokeInput,
  EdgeFunctionsInvokeResult,
} from '@supabase-evals/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DeploymentProbe, NO_HOSTED_PROJECT } from './hosted.js';
import {
  checkQuotesAnswered,
  type ProbeOutcome,
  probeQuotes,
  type ResponsesProbe,
} from './responses.js';
import { QUOTE_PROBES } from './seed.js';

const REF = 'abcdefghijklmnopqrst';
const ANON = 'anon-key-value';
const API_KEYS_PATH = '/v1/projects/{ref}/api-keys';

const QUOTES: Record<string, { quoteCents: number; currency: string }> = {
  IE: { quoteCents: 810, currency: 'EUR' },
  US: { quoteCents: 894, currency: 'USD' },
  GB: { quoteCents: 615, currency: 'GBP' },
};

const SESSION_START = 1_700_000_000_000;
const DEPLOYED_AT = SESSION_START + 60_000;

const deploymentOf = (
  overrides: Partial<{ updatedAtMs: number | undefined }> = {}
): DeploymentProbe => ({
  ok: true,
  deployed: {
    status: 'ACTIVE',
    verifyJwt: true,
    version: 1,
    updatedAtMs: DEPLOYED_AT,
    ...overrides,
  },
});

const iso = (ms: number) => new Date(ms).toISOString();

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

const seededReply = (input: EdgeFunctionsInvokeInput) => {
  const { country, weightKg } = input.body as {
    country: string;
    weightKg: number;
  };
  return reply(200, JSON.stringify({ country, weightKg, ...QUOTES[country] }));
};

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
    options.invoke ?? (async (input) => seededReply(input))
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

type ProbeCtx = Parameters<typeof probeQuotes>[0];
type ProbeOptions = Parameters<typeof probeQuotes>[1];

const noSleep = () => vi.fn(async (_ms: number) => {});

const run = (ctx: ProbeCtx, overrides: Partial<ProbeOptions> = {}) =>
  probeQuotes(ctx, {
    deployment: deploymentOf(),
    sessionStartMs: SESSION_START,
    sleep: noSleep(),
    ...overrides,
  });

const outcomesOf = (probe: ResponsesProbe): ProbeOutcome[] => {
  if (!probe.ok) throw new Error(`probe failed: ${probe.notes}`);
  return probe.outcomes;
};

const NAME = "the deployed function answers with the project's shipping quotes";

describe('probeQuotes', () => {
  it('fails with NO_HOSTED_PROJECT and calls nothing without a hosted project', async () => {
    const { invoke, GET } = fakeCtx();
    expect(await run({ invokeHostedFunction: invoke })).toEqual({
      ok: false,
      notes: NO_HOSTED_PROJECT,
    });
    expect(
      await run({
        hostedRef: REF,
        invokeHostedFunction: invoke,
      })
    ).toEqual({ ok: false, notes: NO_HOSTED_PROJECT });
    expect(
      await run({
        hostedMgmt: { GET } as never,
        invokeHostedFunction: invoke,
      })
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
    expect(await run({})).toEqual({
      ok: false,
      notes: NO_HOSTED_PROJECT,
    });
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

  it('sends each probe as a POST to the function with the anon key and the probe body', async () => {
    const { ctx, invoke } = fakeCtx();
    await run(ctx);
    expect(invoke).toHaveBeenCalledTimes(QUOTE_PROBES.length);
    QUOTE_PROBES.forEach((probe, i) => {
      expect(invoke.mock.calls[i][0]).toMatchObject({
        name: 'shipping-quote',
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

  it('never presents the service role key', async () => {
    const { ctx, invoke } = fakeCtx();
    await run(ctx);
    for (const [input] of invoke.mock.calls) {
      expect(JSON.stringify(input)).not.toContain('service-role-key-value');
    }
  });

  it('prefers the anon key wherever it sits in the list', async () => {
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
    expect(invoke.mock.calls[0][0].headers?.authorization).toBe(
      `Bearer ${ANON}`
    );
  });

  it('sends the anon key on both headers and not the publishable key when the project has both', async () => {
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
    expect(invoke).toHaveBeenCalledTimes(QUOTE_PROBES.length);
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
    const outcomes = outcomesOf(await run(ctx));
    expect(outcomes.map((o) => o.passed)).toEqual([true, true, true]);
    expect(invoke).toHaveBeenCalledTimes(QUOTE_PROBES.length);
    QUOTE_PROBES.forEach((probe, i) => {
      expect(invoke.mock.calls[i][0]).toMatchObject({
        name: 'shipping-quote',
        method: 'POST',
        headers: {
          authorization: 'Bearer sb_publishable_x',
          apikey: 'sb_publishable_x',
          'content-type': 'application/json',
        },
        body: probe.request,
      });
    });
  });

  it('falls back to the publishable key when the anon key has no value', async () => {
    const { ctx, invoke } = fakeCtx({
      keys: [
        { name: 'anon', type: 'legacy' },
        { name: 'default', api_key: 'sb_publishable_x', type: 'publishable' },
      ],
    });
    expect(outcomesOf(await run(ctx)).map((o) => o.passed)).toEqual([
      true,
      true,
      true,
    ]);
    expect(invoke.mock.calls[0][0].headers?.apikey).toBe('sb_publishable_x');
  });

  it('uses the first publishable key that has a value', async () => {
    const { ctx, invoke } = fakeCtx({
      keys: [
        { name: 'empty', type: 'publishable' },
        { name: 'blank', api_key: '', type: 'publishable' },
        { name: 'first', api_key: 'sb_publishable_first', type: 'publishable' },
        {
          name: 'second',
          api_key: 'sb_publishable_second',
          type: 'publishable',
        },
      ],
    });
    await run(ctx);
    expect(invoke).toHaveBeenCalledTimes(QUOTE_PROBES.length);
    for (const [input] of invoke.mock.calls) {
      expect(input.headers).toMatchObject({
        authorization: 'Bearer sb_publishable_first',
        apikey: 'sb_publishable_first',
      });
    }
  });

  it('picks the publishable key by its type, not its name', async () => {
    const { ctx, invoke } = fakeCtx({
      keys: [
        { name: 'publishable', api_key: 'sb_secret_x', type: 'secret' },
        { name: 'default', api_key: 'sb_publishable_x', type: 'publishable' },
      ],
    });
    await run(ctx);
    for (const [input] of invoke.mock.calls) {
      expect(input.headers?.apikey).toBe('sb_publishable_x');
      expect(JSON.stringify(input)).not.toContain('sb_secret_x');
    }
  });

  it('never presents a secret key, even next to a publishable key', async () => {
    const { ctx, invoke } = fakeCtx({
      keys: [
        { name: 'default', api_key: 'sb_secret_x', type: 'secret' },
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

  it('fails without invoking anything when the only keys are secret and service role keys', async () => {
    const { ctx, invoke } = fakeCtx({
      keys: [
        { name: 'service_role', api_key: 'srv-role-value', type: 'legacy' },
        { name: 'default', api_key: 'sb_secret_x', type: 'secret' },
      ],
    });
    expect(await run(ctx)).toEqual({
      ok: false,
      notes: 'no anon or publishable API key on the project',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails without invoking anything when the project has no anon or publishable key', async () => {
    const { ctx, invoke } = fakeCtx({
      keys: [{ name: 'service_role', api_key: 'srv', type: 'legacy' }],
    });
    expect(await run(ctx)).toEqual({
      ok: false,
      notes: 'no anon or publishable API key on the project',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails without invoking anything when the anon key has no value and there is no publishable key', async () => {
    const { ctx, invoke } = fakeCtx({
      keys: [{ name: 'anon', type: 'legacy' }],
    });
    expect(await run(ctx)).toEqual({
      ok: false,
      notes: 'no anon or publishable API key on the project',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails without invoking anything when the publishable key has no value', async () => {
    const { ctx, invoke } = fakeCtx({
      keys: [{ name: 'default', type: 'publishable' }],
    });
    expect(await run(ctx)).toEqual({
      ok: false,
      notes: 'no anon or publishable API key on the project',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails without invoking anything when the key list is empty', async () => {
    const { ctx, invoke } = fakeCtx({ keys: [] });
    expect(await run(ctx)).toEqual({
      ok: false,
      notes: 'no anon or publishable API key on the project',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

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

  it('passes every probe when the function returns the seeded quotes', async () => {
    const { ctx } = fakeCtx();
    const outcomes = outcomesOf(await run(ctx));
    expect(outcomes.map((o) => o.request)).toEqual(
      QUOTE_PROBES.map((probe) => probe.request)
    );
    expect(outcomes.map((o) => o.passed)).toEqual([true, true, true]);
    expect(outcomes[0].detail).toContain('810');
    expect(outcomes[0].detail).toContain('EUR');
    expect(outcomes[1].detail).toContain('894');
    expect(outcomes[1].detail).toContain('USD');
    expect(outcomes[2].detail).toContain('615');
    expect(outcomes[2].detail).toContain('GBP');
  });

  it('accepts a refactored function that adds fields to the answer', async () => {
    const { ctx } = fakeCtx({
      invoke: async (input) => {
        const { country } = input.body as { country: string };
        return reply(
          200,
          JSON.stringify({
            ...QUOTES[country],
            eta: '3 days',
            carrier: 'post',
          })
        );
      },
    });
    expect(outcomesOf(await run(ctx)).map((o) => o.passed)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('fails a probe whose invocation returned an error and names it', async () => {
    const { ctx } = fakeCtx({
      invoke: async () => ({
        type: 'error',
        error: 'edge function not found',
      }),
    });
    const outcomes = outcomesOf(await run(ctx));
    expect(outcomes.map((o) => o.passed)).toEqual([false, false, false]);
    expect(outcomes[0].detail).toBe('error: edge function not found');
  });

  it('fails a non-200 with the status and the body', async () => {
    const { ctx } = fakeCtx({
      invoke: async () =>
        reply(401, '{"error":"Missing authorization header"}'),
    });
    const outcomes = outcomesOf(await run(ctx));
    expect(outcomes.map((o) => o.passed)).toEqual([false, false, false]);
    expect(outcomes[0].detail).toBe(
      'status 401: {"error":"Missing authorization header"}'
    );
  });

  it('fails a 2xx that is not a 200, since the seeded function answers 200', async () => {
    const { ctx } = fakeCtx({
      invoke: async (input) => {
        const ok = seededReply(input);
        return ok.type === 'response' ? { ...ok, status: 201 } : ok;
      },
    });
    const outcomes = outcomesOf(await run(ctx));
    expect(outcomes.map((o) => o.passed)).toEqual([false, false, false]);
    expect(outcomes[0].detail).toContain('status 201');
  });

  it('truncates a long error body to 200 characters', async () => {
    const { ctx } = fakeCtx({
      invoke: async () => reply(500, 'x'.repeat(500)),
    });
    const [first] = outcomesOf(await run(ctx));
    expect(first.detail).toBe(`status 500: ${'x'.repeat(200)}...`);
  });

  it('fails a hello-world answer that is not JSON and shows what came back', async () => {
    const { ctx } = fakeCtx({
      invoke: async () => reply(200, 'Hello from the starter function'),
    });
    const outcomes = outcomesOf(await run(ctx));
    expect(outcomes.map((o) => o.passed)).toEqual([false, false, false]);
    expect(outcomes[0].detail).toContain('Hello from the starter function');
  });

  it.each([
    ['null', 'null'],
    ['a string', '"hi"'],
    ['an array', '[]'],
    ['a number', '810'],
  ])('fails a 200 whose JSON is %s without throwing', async (_label, body) => {
    const { ctx } = fakeCtx({ invoke: async () => reply(200, body) });
    const outcomes = outcomesOf(await run(ctx));
    expect(outcomes.map((o) => o.passed)).toEqual([false, false, false]);
  });

  it('fails a probe whose quote differs from the seeded rates and shows the quote', async () => {
    const { ctx } = fakeCtx({
      invoke: async (input) => {
        const { country } = input.body as { country: string };
        return reply(
          200,
          JSON.stringify({
            quoteCents: QUOTES[country].quoteCents + 1,
            currency: QUOTES[country].currency,
          })
        );
      },
    });
    const outcomes = outcomesOf(await run(ctx));
    expect(outcomes.map((o) => o.passed)).toEqual([false, false, false]);
    expect(outcomes[0].detail).toContain('811');
  });

  it('fails a probe whose currency differs and shows the currency', async () => {
    const { ctx } = fakeCtx({
      invoke: async (input) => {
        const { country } = input.body as { country: string };
        return reply(
          200,
          JSON.stringify({
            quoteCents: QUOTES[country].quoteCents,
            currency: 'JPY',
          })
        );
      },
    });
    const outcomes = outcomesOf(await run(ctx));
    expect(outcomes.map((o) => o.passed)).toEqual([false, false, false]);
    expect(outcomes[0].detail).toContain('JPY');
  });

  it('fails a quote returned as a string rather than a number', async () => {
    const { ctx } = fakeCtx({
      invoke: async (input) => {
        const { country } = input.body as { country: string };
        return reply(
          200,
          JSON.stringify({
            quoteCents: String(QUOTES[country].quoteCents),
            currency: QUOTES[country].currency,
          })
        );
      },
    });
    expect(outcomesOf(await run(ctx)).map((o) => o.passed)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('judges each probe on its own, so one wrong quote does not hide the others', async () => {
    const { ctx } = fakeCtx({
      invoke: async (input) => {
        const { country } = input.body as { country: string };
        return country === 'IE'
          ? reply(200, JSON.stringify({ quoteCents: 1, currency: 'EUR' }))
          : seededReply(input);
      },
    });
    expect(outcomesOf(await run(ctx)).map((o) => o.passed)).toEqual([
      false,
      true,
      true,
    ]);
  });

  it('keeps probing when one invocation throws and records the message', async () => {
    const { ctx, invoke } = fakeCtx({
      invoke: async (input) => {
        if ((input.body as { country: string }).country === 'IE') {
          throw new Error('socket hang up');
        }
        return seededReply(input);
      },
    });
    const outcomes = outcomesOf(await run(ctx));
    expect(invoke).toHaveBeenCalledTimes(QUOTE_PROBES.length);
    expect(outcomes.map((o) => o.passed)).toEqual([false, true, true]);
    expect(outcomes[0].detail).toContain('socket hang up');
  });

  it('fails only the GB probe when only the GB rates changed', async () => {
    const { ctx } = fakeCtx({
      invoke: async (input) => {
        const { country } = input.body as { country: string };
        return country === 'GB'
          ? reply(200, JSON.stringify({ quoteCents: 3, currency: 'GBP' }))
          : seededReply(input);
      },
    });
    const outcomes = outcomesOf(await run(ctx));
    expect(outcomes.map((o) => o.request.country)).toEqual(['IE', 'US', 'GB']);
    expect(outcomes.map((o) => o.passed)).toEqual([true, true, false]);
    expect(outcomes[2].detail).toContain('expected 615 GBP');
  });
});

describe('probeQuotes gate on the deployment', () => {
  const NOT_THIS_RUN = deploymentOf({ updatedAtMs: SESSION_START - 1 });

  it('does not invoke a function that predates the run and says when it was updated', async () => {
    const { ctx, invoke } = fakeCtx();
    expect(await run(ctx, { deployment: NOT_THIS_RUN })).toEqual({
      ok: false,
      notes: `not probed: the deployed shipping-quote predates this run (updated ${iso(SESSION_START - 1)}, session started ${iso(SESSION_START)})`,
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('probes a function updated in the very millisecond the session started', async () => {
    const { ctx, invoke } = fakeCtx();
    const probe = await run(ctx, {
      deployment: deploymentOf({ updatedAtMs: SESSION_START }),
    });
    expect(probe.ok).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(QUOTE_PROBES.length);
  });

  it('fails closed without invoking when the session start is unknown', async () => {
    const { ctx, invoke } = fakeCtx();
    expect(await run(ctx, { sessionStartMs: null })).toEqual({
      ok: false,
      notes:
        "not probed: the deployed shipping-quote can't be tied to this run: session start time unavailable",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails closed without invoking when the API reported no update time', async () => {
    const { ctx, invoke } = fakeCtx();
    expect(
      await run(ctx, { deployment: deploymentOf({ updatedAtMs: undefined }) })
    ).toEqual({
      ok: false,
      notes:
        "not probed: the deployed shipping-quote can't be tied to this run: updated_at missing from the API response",
    });
    expect(invoke).not.toHaveBeenCalled();
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
        'not probed: the project has no shipping-quote function (404: Function not found)',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not invoke when nothing is deployed and the 404 carried no message', async () => {
    const { ctx, invoke } = fakeCtx();
    expect(
      await run(ctx, { deployment: { ok: true, deployed: null } })
    ).toEqual({
      ok: false,
      notes: 'not probed: the project has no shipping-quote function',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not invoke when the deployment could not be read and names why', async () => {
    const { ctx, invoke } = fakeCtx();
    expect(
      await run(ctx, {
        deployment: { ok: false, notes: 'connection reset' },
      })
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

describe('probeQuotes retries a cold boot', () => {
  const scripted = (script: Record<string, EdgeFunctionsInvokeResult[]>) => {
    const attempts: Record<string, number> = {};
    const invoke: Invoke = async (input) => {
      const { country } = input.body as { country: string };
      attempts[country] = (attempts[country] ?? 0) + 1;
      return script[country]?.[attempts[country] - 1] ?? seededReply(input);
    };
    return invoke;
  };

  const countryOf = ([input]: [EdgeFunctionsInvokeInput]) =>
    (input.body as { country: string }).country;

  const callsFor = (
    invoke: { mock: { calls: [EdgeFunctionsInvokeInput][] } },
    country: string
  ) => invoke.mock.calls.filter((args) => countryOf(args) === country).length;

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes a probe whose first call hit a 503 and whose retry answered', async () => {
    const sleep = noSleep();
    const { ctx, invoke } = fakeCtx({
      invoke: scripted({ IE: [reply(503, '{"code":"BOOT_ERROR"}')] }),
    });
    const outcomes = outcomesOf(await run(ctx, { sleep }));
    expect(outcomes.map((o) => o.passed)).toEqual([true, true, true]);
    expect(outcomes[0].detail).toContain('quote 810 EUR');
    expect(callsFor(invoke, 'IE')).toBe(2);
    expect(invoke).toHaveBeenCalledTimes(QUOTE_PROBES.length + 1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it.each([502, 503, 504])('retries a %i', async (status) => {
    const { ctx, invoke } = fakeCtx({
      invoke: scripted({ IE: [reply(status, 'booting')] }),
    });
    const outcomes = outcomesOf(await run(ctx));
    expect(outcomes.map((o) => o.passed)).toEqual([true, true, true]);
    expect(callsFor(invoke, 'IE')).toBe(2);
  });

  it('passes a probe that only answers on its third attempt', async () => {
    const sleep = noSleep();
    const { ctx, invoke } = fakeCtx({
      invoke: scripted({ IE: [reply(503, 'boot'), reply(503, 'boot')] }),
    });
    const outcomes = outcomesOf(await run(ctx, { sleep }));
    expect(outcomes.map((o) => o.passed)).toEqual([true, true, true]);
    expect(callsFor(invoke, 'IE')).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('resends the same request on a retry', async () => {
    const { ctx, invoke } = fakeCtx({
      invoke: scripted({ IE: [reply(503, 'boot')] }),
    });
    await run(ctx);
    const [first, second] = invoke.mock.calls;
    expect(second[0]).toEqual(first[0]);
    expect(first[0].body).toEqual(QUOTE_PROBES[0].request);
  });

  it('gives up after three attempts and reports the last status and the attempt count', async () => {
    const always503: EdgeFunctionsInvokeResult[] = Array.from(
      { length: 10 },
      () => reply(503, '{"code":"BOOT_ERROR"}')
    );
    const sleep = noSleep();
    const { ctx, invoke } = fakeCtx({ invoke: scripted({ IE: always503 }) });
    const outcomes = outcomesOf(await run(ctx, { sleep }));
    expect(outcomes[0]).toMatchObject({
      passed: false,
      detail: 'status 503: {"code":"BOOT_ERROR"} (after 3 attempts)',
    });
    expect(callsFor(invoke, 'IE')).toBe(3);
  });

  it('retries each probe on its own attempts, so one cold function does not spend the others', async () => {
    const always503: EdgeFunctionsInvokeResult[] = Array.from(
      { length: 10 },
      () => reply(503, 'boot')
    );
    const { ctx, invoke } = fakeCtx({ invoke: scripted({ IE: always503 }) });
    const outcomes = outcomesOf(await run(ctx));
    expect(outcomes.map((o) => o.passed)).toEqual([false, true, true]);
    expect(callsFor(invoke, 'US')).toBe(1);
    expect(callsFor(invoke, 'GB')).toBe(1);
  });

  it('waits between attempts with a growing delay and never after the last attempt', async () => {
    const always503: EdgeFunctionsInvokeResult[] = Array.from(
      { length: 10 },
      () => reply(503, 'boot')
    );
    const sleep = noSleep();
    const { ctx } = fakeCtx({ invoke: scripted({ IE: always503 }) });
    await run(ctx, { sleep });
    const delays = sleep.mock.calls.map(([ms]) => ms);
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThan(0);
    expect(delays[1]).toBeGreaterThanOrEqual(delays[0]);
    expect(delays[1]).toBeLessThanOrEqual(5_000);
  });

  it('reports the last status when the status changes across attempts', async () => {
    const { ctx, invoke } = fakeCtx({
      invoke: scripted({
        IE: [reply(503, 'boot'), reply(503, 'boot'), reply(500, 'boom')],
      }),
    });
    const outcomes = outcomesOf(await run(ctx));
    expect(outcomes[0]).toMatchObject({
      passed: false,
      detail: 'status 500: boom (after 3 attempts)',
    });
    expect(callsFor(invoke, 'IE')).toBe(3);
  });

  it('stops at a non-retriable status that follows a 503', async () => {
    const { ctx, invoke } = fakeCtx({
      invoke: scripted({ IE: [reply(503, 'boot'), reply(401, 'denied')] }),
    });
    const outcomes = outcomesOf(await run(ctx));
    expect(outcomes[0]).toMatchObject({
      passed: false,
      detail: 'status 401: denied (after 2 attempts)',
    });
    expect(callsFor(invoke, 'IE')).toBe(2);
  });

  it.each([401, 404, 429, 500, 501])('does not retry a %i', async (status) => {
    const sleep = noSleep();
    const { ctx, invoke } = fakeCtx({
      invoke: async () => reply(status, 'denied'),
    });
    const outcomes = outcomesOf(await run(ctx, { sleep }));
    expect(outcomes.map((o) => o.detail)).toEqual(
      QUOTE_PROBES.map(() => `status ${status}: denied`)
    );
    expect(invoke).toHaveBeenCalledTimes(QUOTE_PROBES.length);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry an invoker error result', async () => {
    const sleep = noSleep();
    const { ctx, invoke } = fakeCtx({
      invoke: async () => ({ type: 'error', error: 'edge function not found' }),
    });
    const outcomes = outcomesOf(await run(ctx, { sleep }));
    expect(outcomes[0].detail).toBe('error: edge function not found');
    expect(invoke).toHaveBeenCalledTimes(QUOTE_PROBES.length);
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
    expect(invoke).toHaveBeenCalledTimes(QUOTE_PROBES.length);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry a 200 with the wrong answer', async () => {
    const sleep = noSleep();
    const { ctx, invoke } = fakeCtx({
      invoke: async () => reply(200, 'Hello from the starter'),
    });
    await run(ctx, { sleep });
    expect(invoke).toHaveBeenCalledTimes(QUOTE_PROBES.length);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('waits on the clock between attempts when no sleep is injected', async () => {
    vi.useFakeTimers();
    const { ctx, invoke } = fakeCtx({
      invoke: scripted({ IE: [reply(503, 'boot')] }),
    });
    const pending = probeQuotes(ctx, {
      deployment: deploymentOf(),
      sessionStartMs: SESSION_START,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(outcomesOf(await pending).map((o) => o.passed)).toEqual([
      true,
      true,
      true,
    ]);
    expect(invoke).toHaveBeenCalledTimes(QUOTE_PROBES.length + 1);
  });
});

describe('checkQuotesAnswered', () => {
  const passing = (detail: string): ProbeOutcome[] => [
    { request: { country: 'IE', weightKg: 2.3 }, passed: true, detail },
    { request: { country: 'US', weightKg: 0.4 }, passed: true, detail },
    { request: { country: 'GB', weightKg: 1.5 }, passed: true, detail },
  ];

  it('passes when every probe passed and lists each outcome', () => {
    expect(
      checkQuotesAnswered({
        ok: true,
        outcomes: [
          {
            request: { country: 'IE', weightKg: 2.3 },
            passed: true,
            detail: 'quote 810 EUR',
          },
          {
            request: { country: 'US', weightKg: 0.4 },
            passed: true,
            detail: 'quote 894 USD',
          },
          {
            request: { country: 'GB', weightKg: 1.5 },
            passed: true,
            detail: 'quote 615 GBP',
          },
        ],
      })
    ).toEqual({
      name: NAME,
      passed: true,
      notes:
        'IE 2.3kg: quote 810 EUR; US 0.4kg: quote 894 USD; GB 1.5kg: quote 615 GBP',
    });
  });

  it('fails when any probe failed and still lists every outcome', () => {
    const [ie, , gb] = passing('quote 810 EUR');
    expect(
      checkQuotesAnswered({
        ok: true,
        outcomes: [
          ie,
          {
            request: { country: 'US', weightKg: 0.4 },
            passed: false,
            detail: 'status 401: unauthorized',
          },
          gb,
        ],
      })
    ).toEqual({
      name: NAME,
      passed: false,
      notes:
        'IE 2.3kg: quote 810 EUR; US 0.4kg: status 401: unauthorized; GB 1.5kg: quote 810 EUR',
    });
  });

  it('fails when only the last probe failed', () => {
    const [ie, us] = passing('ok');
    expect(
      checkQuotesAnswered({
        ok: true,
        outcomes: [
          ie,
          us,
          {
            request: { country: 'GB', weightKg: 1.5 },
            passed: false,
            detail: 'answered {"quoteCents":3}, expected 615 GBP',
          },
        ],
      })
    ).toMatchObject({
      passed: false,
      notes:
        'IE 2.3kg: ok; US 0.4kg: ok; GB 1.5kg: answered {"quoteCents":3}, expected 615 GBP',
    });
  });

  it('fails when every probe failed', () => {
    expect(
      checkQuotesAnswered({
        ok: true,
        outcomes: passing('x').map((o) => ({ ...o, passed: false })),
      }).passed
    ).toBe(false);
  });

  it('never passes with no outcomes at all', () => {
    expect(checkQuotesAnswered({ ok: true, outcomes: [] }).passed).toBe(false);
  });

  it('fails with the probe notes when the probe could not run', () => {
    expect(
      checkQuotesAnswered({ ok: false, notes: NO_HOSTED_PROJECT })
    ).toEqual({ name: NAME, passed: false, notes: NO_HOSTED_PROJECT });
  });
});
