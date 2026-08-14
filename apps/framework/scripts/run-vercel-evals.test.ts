import { APIError } from '@vercel/sandbox';
import { describe, expect, it } from 'vitest';
import {
  isRetryableSandboxCreateError,
  isTerminalSandboxCreateError,
  parsePairs,
  runBounded,
  tagValue,
} from './run-vercel-evals.js';

describe('Vercel eval controller', () => {
  it('bounds concurrent work and lets independent failures settle', async () => {
    let active = 0;
    let maximum = 0;
    const results = await runBounded([1, 2, 3, 4], 2, async (item) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      if (item === 2) throw new Error('terminal');
      return item;
    });

    expect(maximum).toBe(2);
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
    ]);
  });

  it('sanitizes Sandbox names and tags to the allowed charset', () => {
    expect(tagValue('openai-gpt-5.4-nano')).toBe('openai-gpt-5-4-nano');
    expect(tagValue('Build CLI / Bootstrap App!')).toBe(
      'build-cli-bootstrap-app-'
    );
    expect(tagValue('a'.repeat(100))).toHaveLength(64);
  });

  it('validates pair input before starting Sandboxes', () => {
    expect(
      parsePairs(
        JSON.stringify([
          {
            eval_id: 'eval-1',
            experiment: 'experiment-1',
            experiment_suite: 'benchmark',
            eval_suite: 'benchmark',
          },
        ])
      )
    ).toHaveLength(1);
    expect(() => parsePairs('[{"eval_id":"eval-1"}]')).toThrow(
      'each pair must contain'
    );
  });

  it('retries sandbox creation only on 429s and 5xx API responses', () => {
    const apiError = (status: number) =>
      new APIError(new Response(null, { status }));
    expect(isRetryableSandboxCreateError(apiError(429), 1)).toBe(true);
    expect(isRetryableSandboxCreateError(apiError(500), 1)).toBe(true);
    expect(isRetryableSandboxCreateError(apiError(401), 1)).toBe(false);
    expect(isRetryableSandboxCreateError(apiError(400), 1)).toBe(false);
  });

  it('bails immediately on a bad OIDC token', () => {
    const localOidc = Object.assign(
      new Error('Could not get credentials from OIDC context.'),
      { name: 'LocalOidcContextError' }
    );
    const vercelOidc = Object.assign(
      new Error('Could not get credentials from OIDC context.'),
      { name: 'VercelOidcContextError' }
    );
    const invalidToken = new Error('Invalid Vercel OIDC token: bad payload');

    expect(isRetryableSandboxCreateError(localOidc, 1)).toBe(false);
    expect(isRetryableSandboxCreateError(vercelOidc, 1)).toBe(false);
    expect(isRetryableSandboxCreateError(invalidToken, 1)).toBe(false);
    expect(isRetryableSandboxCreateError(localOidc, 12)).toBe(false);
  });

  it('retries a real network error through the full attempt budget', () => {
    const networkError = new TypeError('fetch failed', {
      cause: Object.assign(new Error('read ECONNRESET'), {
        code: 'ECONNRESET',
      }),
    });
    expect(isRetryableSandboxCreateError(networkError, 1)).toBe(true);
    expect(isRetryableSandboxCreateError(networkError, 12)).toBe(true);
  });

  it('caps an unrecognized error to a couple of attempts', () => {
    const mystery = new Error('something we have never seen');
    expect(isRetryableSandboxCreateError(mystery, 1)).toBe(true);
    expect(isRetryableSandboxCreateError(mystery, 2)).toBe(true);
    expect(isRetryableSandboxCreateError(mystery, 3)).toBe(false);
  });

  it('marks credential errors and definitive 4xx as terminal', () => {
    const apiError = (status: number) =>
      new APIError(new Response(null, { status }));
    const credentialError = Object.assign(
      new Error('Could not get credentials from OIDC context.'),
      { name: 'LocalOidcContextError' }
    );

    expect(isTerminalSandboxCreateError(credentialError)).toBe(true);
    expect(isTerminalSandboxCreateError(apiError(401))).toBe(true);
    expect(isTerminalSandboxCreateError(apiError(400))).toBe(true);
  });

  it('does not mark retryable or unknown errors as terminal', () => {
    const apiError = (status: number) =>
      new APIError(new Response(null, { status }));
    const networkError = new TypeError('fetch failed', {
      cause: Object.assign(new Error('read ECONNRESET'), {
        code: 'ECONNRESET',
      }),
    });
    const mystery = new Error('something we have never seen');

    expect(isTerminalSandboxCreateError(apiError(429))).toBe(false);
    expect(isTerminalSandboxCreateError(apiError(500))).toBe(false);
    expect(isTerminalSandboxCreateError(networkError)).toBe(false);
    expect(isTerminalSandboxCreateError(mystery)).toBe(false);
  });
});
