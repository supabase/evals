// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-functions-002-deploy-and-call
import type {
  EdgeFunctionsInvokeInput,
  EdgeFunctionsInvokeResult,
} from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import { NO_HOSTED_PROJECT } from './hosted.js';
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
};

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

const outcomesOf = (probe: ResponsesProbe): ProbeOutcome[] => {
  if (!probe.ok) throw new Error(`probe failed: ${probe.notes}`);
  return probe.outcomes;
};

const NAME = "the deployed function answers with the project's shipping quotes";

describe('probeQuotes', () => {
  it('fails with NO_HOSTED_PROJECT and calls nothing without a hosted project', async () => {
    const { invoke, GET } = fakeCtx();
    expect(await probeQuotes({ invokeHostedFunction: invoke })).toEqual({
      ok: false,
      notes: NO_HOSTED_PROJECT,
    });
    expect(
      await probeQuotes({
        hostedRef: REF,
        invokeHostedFunction: invoke,
      })
    ).toEqual({ ok: false, notes: NO_HOSTED_PROJECT });
    expect(
      await probeQuotes({
        hostedMgmt: { GET } as never,
        invokeHostedFunction: invoke,
      })
    ).toEqual({ ok: false, notes: NO_HOSTED_PROJECT });
    expect(GET).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails with the invoker note when the context cannot invoke a hosted function', async () => {
    const { ctx, invoke } = fakeCtx({ invoke: null });
    expect(await probeQuotes(ctx)).toEqual({
      ok: false,
      notes: 'no hosted function invoker on the scoring context',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reports the missing hosted project ahead of the missing invoker', async () => {
    expect(await probeQuotes({})).toEqual({
      ok: false,
      notes: NO_HOSTED_PROJECT,
    });
  });

  it('looks the anon key up on the project', async () => {
    const { ctx, GET } = fakeCtx();
    await probeQuotes(ctx);
    expect(GET).toHaveBeenCalledWith(
      API_KEYS_PATH,
      expect.objectContaining({
        params: expect.objectContaining({ path: { ref: REF } }),
      })
    );
  });

  it('sends each probe as a POST to the function with the anon key and the probe body', async () => {
    const { ctx, invoke } = fakeCtx();
    await probeQuotes(ctx);
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
    await probeQuotes(ctx);
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
    await probeQuotes(ctx);
    expect(invoke.mock.calls[0][0].headers?.authorization).toBe(
      `Bearer ${ANON}`
    );
  });

  it('falls back to a publishable key when there is no anon key', async () => {
    const { ctx, invoke } = fakeCtx({
      keys: [
        { name: 'service_role', api_key: 'srv', type: 'legacy' },
        { name: 'default', api_key: 'sb_publishable_x', type: 'publishable' },
      ],
    });
    expect(outcomesOf(await probeQuotes(ctx)).every((o) => o.passed)).toBe(
      true
    );
    expect(invoke.mock.calls[0][0].headers?.authorization).toBe(
      'Bearer sb_publishable_x'
    );
  });

  it('fails without invoking anything when the project has no usable key', async () => {
    const { ctx, invoke } = fakeCtx({
      keys: [{ name: 'service_role', api_key: 'srv', type: 'legacy' }],
    });
    expect(await probeQuotes(ctx)).toEqual({
      ok: false,
      notes: 'no anon or publishable API key on the project',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails without invoking anything when the key list is empty', async () => {
    const { ctx, invoke } = fakeCtx({ keys: [] });
    expect(await probeQuotes(ctx)).toEqual({
      ok: false,
      notes: 'no anon or publishable API key on the project',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails with the error when the keys cannot be read', async () => {
    const { ctx, invoke } = fakeCtx({
      keysError: { status: 500, body: { message: 'keys unavailable' } },
    });
    const probe = await probeQuotes(ctx);
    expect(probe.ok).toBe(false);
    expect(!probe.ok && probe.notes).toContain('keys unavailable');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails with the message when the key lookup throws, and never rejects', async () => {
    const { ctx, invoke } = fakeCtx({ keysThrow: 'connection reset' });
    const probe = await probeQuotes(ctx);
    expect(probe.ok).toBe(false);
    expect(!probe.ok && probe.notes).toContain('connection reset');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('passes both probes when the function returns the seeded quotes', async () => {
    const { ctx } = fakeCtx();
    const outcomes = outcomesOf(await probeQuotes(ctx));
    expect(outcomes.map((o) => o.request)).toEqual(
      QUOTE_PROBES.map((probe) => probe.request)
    );
    expect(outcomes.map((o) => o.passed)).toEqual([true, true]);
    expect(outcomes[0].detail).toContain('810');
    expect(outcomes[0].detail).toContain('EUR');
    expect(outcomes[1].detail).toContain('894');
    expect(outcomes[1].detail).toContain('USD');
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
    expect(outcomesOf(await probeQuotes(ctx)).map((o) => o.passed)).toEqual([
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
    const outcomes = outcomesOf(await probeQuotes(ctx));
    expect(outcomes.map((o) => o.passed)).toEqual([false, false]);
    expect(outcomes[0].detail).toBe('error: edge function not found');
  });

  it('fails a non-200 with the status and the body', async () => {
    const { ctx } = fakeCtx({
      invoke: async () =>
        reply(401, '{"error":"Missing authorization header"}'),
    });
    const outcomes = outcomesOf(await probeQuotes(ctx));
    expect(outcomes.map((o) => o.passed)).toEqual([false, false]);
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
    const outcomes = outcomesOf(await probeQuotes(ctx));
    expect(outcomes.map((o) => o.passed)).toEqual([false, false]);
    expect(outcomes[0].detail).toContain('status 201');
  });

  it('truncates a long error body to 200 characters', async () => {
    const { ctx } = fakeCtx({
      invoke: async () => reply(500, 'x'.repeat(500)),
    });
    const [first] = outcomesOf(await probeQuotes(ctx));
    expect(first.detail).toBe(`status 500: ${'x'.repeat(200)}...`);
  });

  it('fails a hello-world answer that is not JSON and shows what came back', async () => {
    const { ctx } = fakeCtx({
      invoke: async () => reply(200, 'Hello from the starter function'),
    });
    const outcomes = outcomesOf(await probeQuotes(ctx));
    expect(outcomes.map((o) => o.passed)).toEqual([false, false]);
    expect(outcomes[0].detail).toContain('Hello from the starter function');
  });

  it.each([
    ['null', 'null'],
    ['a string', '"hi"'],
    ['an array', '[]'],
    ['a number', '810'],
  ])('fails a 200 whose JSON is %s without throwing', async (_label, body) => {
    const { ctx } = fakeCtx({ invoke: async () => reply(200, body) });
    const outcomes = outcomesOf(await probeQuotes(ctx));
    expect(outcomes.map((o) => o.passed)).toEqual([false, false]);
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
    const outcomes = outcomesOf(await probeQuotes(ctx));
    expect(outcomes.map((o) => o.passed)).toEqual([false, false]);
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
    const outcomes = outcomesOf(await probeQuotes(ctx));
    expect(outcomes.map((o) => o.passed)).toEqual([false, false]);
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
    expect(outcomesOf(await probeQuotes(ctx)).map((o) => o.passed)).toEqual([
      false,
      false,
    ]);
  });

  it('judges each probe on its own, so one wrong quote does not hide the other', async () => {
    const { ctx } = fakeCtx({
      invoke: async (input) => {
        const { country } = input.body as { country: string };
        return country === 'IE'
          ? reply(200, JSON.stringify({ quoteCents: 1, currency: 'EUR' }))
          : seededReply(input);
      },
    });
    expect(outcomesOf(await probeQuotes(ctx)).map((o) => o.passed)).toEqual([
      false,
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
    const outcomes = outcomesOf(await probeQuotes(ctx));
    expect(invoke).toHaveBeenCalledTimes(QUOTE_PROBES.length);
    expect(outcomes.map((o) => o.passed)).toEqual([false, true]);
    expect(outcomes[0].detail).toContain('socket hang up');
  });
});

describe('checkQuotesAnswered', () => {
  const passing = (detail: string): ProbeOutcome[] => [
    { request: { country: 'IE', weightKg: 2.3 }, passed: true, detail },
    { request: { country: 'US', weightKg: 0.4 }, passed: true, detail },
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
        ],
      })
    ).toEqual({
      name: NAME,
      passed: true,
      notes: 'IE 2.3kg: quote 810 EUR; US 0.4kg: quote 894 USD',
    });
  });

  it('fails when any probe failed and still lists every outcome', () => {
    const [ie] = passing('quote 810 EUR');
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
        ],
      })
    ).toEqual({
      name: NAME,
      passed: false,
      notes: 'IE 2.3kg: quote 810 EUR; US 0.4kg: status 401: unauthorized',
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
