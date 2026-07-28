import { describe, expect, test } from 'vitest';
import {
  checksMessage,
  failedCheckNames,
  functionResponse,
} from '../../test-utils/scorer-test-kit.js';
import type {
  EdgeFunctionsInvokeResult,
  ToolEvalContext,
} from '@supabase-evals/core';
import scorer from './EVAL.js';

/**
 * Unlike the other scorer tests, this one fakes the `ToolEvalContext` instead
 * of booting a real backend: the scorer's *decision logic* (which statuses and
 * bodies pass) is what we want to pin, and driving that through a real stack
 * would mean deploying six edge-function variants.
 */
function fakeCtx(responses: EdgeFunctionsInvokeResult[]): ToolEvalContext {
  const authResult = (id: string, accessToken: string) => ({
    data: { user: { id }, session: { access_token: accessToken } },
    error: null,
  });
  const clientA = {
    auth: { signUp: async () => authResult('user-a', 'token-a') },
  } as unknown as ToolEvalContext['client'];
  const clientB = {
    auth: { signUp: async () => authResult('user-b', 'token-b') },
  } as unknown as ToolEvalContext['client'];

  return {
    mgmt: {} as ToolEvalContext['mgmt'],
    ref: 'test-ref',
    client: clientA,
    getClient: () => clientB,
    query: async () => ({ rows: [] }),
    invokeFunction: async () => {
      const response = responses.shift();
      if (!response) throw new Error('missing fake function response');
      return response;
    },
    toolCalls: [],
    transcript: [],
  };
}

type Role = 'missingAuth' | 'ownNotes' | 'aRequestsB' | 'bRequestsA';

/**
 * Responses are consumed in the scorer's invocation order (missingAuth,
 * ownNotes, aRequestsB, bRequestsA); overrides are keyed by role.
 */
function runScorer(
  overrides: Partial<Record<Role, EdgeFunctionsInvokeResult>> = {}
) {
  return scorer(
    fakeCtx([
      overrides.missingAuth ?? functionResponse(401),
      overrides.ownNotes ??
        functionResponse(200, 'user A private note', ['token-a']),
      overrides.aRequestsB ?? functionResponse(401, 'unauthorized'),
      overrides.bRequestsA ?? functionResponse(403, 'forbidden'),
    ])
  );
}

describe('secure shapes the scorer must accept', () => {
  test('rejects anonymous access, serves own note, denies cross-user reads', async () => {
    const result = await runScorer();

    expect(result.passed, checksMessage(result)).toBe(true);
    expect(checksMessage(result)).toMatch(/"notes":"status=401"/);
    expect(checksMessage(result)).toMatch(/"notes":"status=200"/);
    expect(checksMessage(result)).toMatch(/"notes":"status=403"/);
    expect(checksMessage(result)).toMatch(
      /"notes":"bearer_tokens=1, all_match=true"/
    );
  });

  test('ignoring the spoofed user_id and returning the caller their own note', async () => {
    const result = await runScorer({
      aRequestsB: functionResponse(200, 'user A private note', ['token-a']),
      bRequestsA: functionResponse(200, 'user B private note', ['token-b']),
    });

    expect(result.passed, checksMessage(result)).toBe(true);
  });

  test('404 from an RLS-scoped read that returns no rows', async () => {
    const result = await runScorer({
      aRequestsB: functionResponse(404, 'not found'),
      bRequestsA: functionResponse(404, 'not found'),
    });

    expect(result.passed, checksMessage(result)).toBe(true);
  });
});

describe('leaks and bypasses the scorer must reject', () => {
  test('a leaked note fails regardless of status', async () => {
    const result = await runScorer({
      aRequestsB: functionResponse(200, 'user B private note'),
      bRequestsA: functionResponse(403, 'user A private note'),
    });

    expect(result.passed, checksMessage(result)).toBe(false);
    expect(failedCheckNames(result)).toEqual([
      'user A cannot force-read user B note',
      'user B cannot force-read user A note',
    ]);
  });

  test('serving data to an unauthenticated caller fails without any leak', async () => {
    const result = await runScorer({ missingAuth: functionResponse(200) });

    expect(result.passed, checksMessage(result)).toBe(false);
    expect(failedCheckNames(result)).toEqual(['rejects missing auth']);
  });

  test('a 401 that still echoes a note is a leak, not a denial', async () => {
    const result = await runScorer({
      missingAuth: functionResponse(401, 'user A private note'),
    });

    expect(result.passed, checksMessage(result)).toBe(false);
    expect(failedCheckNames(result)).toEqual(['rejects missing auth']);
  });

  test('reading via the service-role key instead of the caller JWT fails', async () => {
    const result = await runScorer({
      ownNotes: functionResponse(200, 'user A private note', [
        'service-role-key',
      ]),
    });

    expect(result.passed, checksMessage(result)).toBe(false);
    expect(failedCheckNames(result)).toEqual([
      "reads only with the caller's JWT",
    ]);
  });
});
