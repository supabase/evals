import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';

import { FUNCTION, MISSING_KEY_MARKER, PROVIDER_KEY } from './fixture.js';

/** A cold `per_worker` runtime boots a worker on the first request. */
const ATTEMPTS = 5;
const RETRY_MS = 2000;

type Response = { status: number; body: string };

export type ProbeChecks = {
  served: CheckResult;
  keyAtRuntime: CheckResult;
  noEcho: CheckResult;
};

/**
 * The end-to-end phase. `projectRunning: false`, so the agent starts the stack
 * itself and its own env file is on disk before the edge runtime container is
 * created. That ordering is the thing under test: the guide is the only place
 * that says where the file has to sit for `supabase start` to pick it up.
 */
export async function checkProbes(
  ctx: LocalStackEvalContext,
  marker: string
): Promise<ProbeChecks> {
  const status = await readStatus(ctx);
  const apiUrl = str(status.API_URL);
  if (!apiUrl) {
    return blocked(
      'the local stack is not running, so nothing serves the function'
    );
  }

  const url = `${apiUrl}/functions/v1/${FUNCTION}`;
  const key = str(status.PUBLISHABLE_KEY) ?? str(status.ANON_KEY);
  const response = await poll(url, key, marker);

  if (!response) {
    return blocked(`no response from ${url}`);
  }
  if (response.status === 404) {
    return blocked(`${url} returned 404, so no function is deployed there`);
  }

  const served: CheckResult = {
    name: 'the local stack serves the suggest endpoint',
    passed: true,
    notes: `status ${response.status}`,
  };

  // Pass on anything that is not the seed's missing-credential contract. The
  // sandbox has no route to the provider, so the upstream call fails and a 5xx
  // is the expected shape of a correct solution. What a correct solution must
  // not say is that the credential never arrived.
  const missing = response.body.includes(MISSING_KEY_MARKER);
  const keyAtRuntime: CheckResult = {
    name: 'the suggest endpoint has the provider key at request time',
    passed: !missing,
    notes: missing
      ? `answered ${MISSING_KEY_MARKER}, so the runtime handed the function no credential: ${preview(response.body)}`
      : `status ${response.status}: ${preview(response.body)}`,
  };

  const echoed = response.body.includes(PROVIDER_KEY);
  const noEcho: CheckResult = {
    name: 'the suggest response does not echo the provider key',
    passed: !echoed,
    notes: echoed
      ? 'the response body carries the provider key back to the caller'
      : undefined,
  };

  return { served, keyAtRuntime, noEcho };
}

/** A blocked probe fails. Reporting it green hands a clean sheet to a run that produced nothing. */
function blocked(reason: string): ProbeChecks {
  return {
    served: {
      name: 'the local stack serves the suggest endpoint',
      passed: false,
      notes: reason,
    },
    keyAtRuntime: {
      name: 'the suggest endpoint has the provider key at request time',
      passed: false,
      notes: 'not run because the suggest endpoint was not served',
    },
    noEcho: {
      name: 'the suggest response does not echo the provider key',
      passed: false,
      notes: 'not run because the suggest endpoint was not served',
    },
  };
}

async function poll(
  url: string,
  key: string | undefined,
  marker: string
): Promise<Response | undefined> {
  let last: Response | undefined;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_MS);
    const response = await invoke(url, key, marker);
    if (response) {
      last = response;
      if (!stillBooting(response)) return response;
    }
  }
  return last;
}

/**
 * A gateway error with nothing in the body is the runtime still coming up. The
 * seed's own contract answers 503 with a body, so that is an answer and not
 * something to wait out.
 */
function stillBooting(response: Response): boolean {
  return (
    (response.status === 502 || response.status === 503) &&
    response.body.trim().length === 0
  );
}

/**
 * Tries the publishable key first, then no credentials. The agent decides
 * whether to leave `verify_jwt` on, and the scorer's choice of header should
 * not be what fails a working function.
 */
async function invoke(
  url: string,
  key: string | undefined,
  marker: string
): Promise<Response | undefined> {
  const attempts: Record<string, string>[] = [];
  if (key) {
    attempts.push({ apikey: key, authorization: `Bearer ${key}` });
  }
  attempts.push({});

  let last: Response | undefined;
  for (const auth of attempts) {
    const response = await send(url, auth, marker);
    if (!response) continue;
    last = response;
    if (response.status !== 401) return response;
  }
  return last;
}

async function send(
  url: string,
  auth: Record<string, string>,
  marker: string
): Promise<Response | undefined> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: `a stainless steel kettle ${marker}` }),
      signal: AbortSignal.timeout(30_000),
    });
    return { status: res.status, body: await res.text() };
  } catch {
    return undefined;
  }
}

/** Reads `supabase status`, with stderr dropped so its `Stopped services` chatter cannot lead a failure note. */
async function readStatus(
  ctx: LocalStackEvalContext
): Promise<Record<string, unknown>> {
  const result = await ctx.exec('supabase status -o json 2>/dev/null');
  const start = result.stdout.indexOf('{');
  const end = result.stdout.lastIndexOf('}');
  if (start === -1 || end <= start) return {};
  try {
    return JSON.parse(result.stdout.slice(start, end + 1)) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function preview(body: string): string {
  return body.replace(/\s+/g, ' ').slice(0, 200);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
