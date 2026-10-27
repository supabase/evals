import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { errorMessage, truncate } from '../lib/shell.js';
import {
  type DeploymentProbe,
  judgeRedeploy,
  NO_HOSTED_PROJECT,
  notFoundSuffix,
} from './hosted.js';
import { FUNCTION_SLUG, PROMO_PROBES, type PromoProbe } from './seed.js';

type InvokeContext = Pick<
  LocalStackEvalContext,
  'hostedMgmt' | 'hostedRef' | 'invokeHostedFunction'
>;
type Invoke = NonNullable<InvokeContext['invokeHostedFunction']>;

export type ProbeOutcome = {
  group: PromoProbe['group'];
  request: PromoProbe['request'];
  passed: boolean;
  detail: string;
};

export type ResponsesProbe =
  | { ok: true; outcomes: ProbeOutcome[] }
  | { ok: false; notes: string };

async function readClientKey(
  hostedMgmt: NonNullable<InvokeContext['hostedMgmt']>,
  ref: string
): Promise<{ key: string } | { notes: string }> {
  const res = await hostedMgmt.GET('/v1/projects/{ref}/api-keys', {
    params: { path: { ref } },
  });
  if (res.error || !res.data) {
    return {
      notes: `could not read the project's API keys: status ${res.response.status} ${truncate(JSON.stringify(res.error ?? null), 200)}`,
    };
  }
  const key =
    res.data.find(({ name, api_key }) => name === 'anon' && api_key) ??
    res.data.find(({ type, api_key }) => type === 'publishable' && api_key);
  return key?.api_key
    ? { key: key.api_key }
    : { notes: 'no anon or publishable API key on the project' };
}

function judgeAnswer(
  status: number,
  body: string,
  { request, expected }: PromoProbe
): Pick<ProbeOutcome, 'passed' | 'detail'> {
  let answer: unknown;
  try {
    answer = JSON.parse(body);
  } catch {
    answer = undefined;
  }
  const { valid, code, discountCents, totalCents, reason } = (answer ??
    {}) as Record<string, unknown>;
  const passed = expected.valid
    ? status === 200 &&
      valid === true &&
      discountCents === expected.discountCents &&
      totalCents === request.cartCents - expected.discountCents &&
      typeof code === 'string' &&
      code.toLowerCase() === request.code.toLowerCase()
    : status < 500 &&
      valid === false &&
      typeof reason === 'string' &&
      reason.trim() !== '';
  if (passed) {
    return {
      passed,
      detail: expected.valid ? `discount ${discountCents}` : 'rejected',
    };
  }
  return { passed, detail: `status ${status}: ${truncate(body, 200)}` };
}

const RETRIED_STATUSES = new Set([502, 503, 504]);
const BACKOFF_MS = [1000, 2000];
const SETTLE_DELAYS_MS = [2000, 3000, 5000];
type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));
type Attempt = Pick<ProbeOutcome, 'passed' | 'detail'> & {
  retry: boolean;
  wrongAnswer: boolean;
};
type Ran = { outcome: ProbeOutcome; wrongAnswer: boolean };

async function sendProbe(
  invoke: Invoke,
  key: string,
  probe: PromoProbe
): Promise<Attempt> {
  try {
    const result = await invoke({
      name: FUNCTION_SLUG,
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        apikey: key,
        'content-type': 'application/json',
      },
      body: probe.request,
    });
    if (result.type === 'error') {
      return {
        passed: false,
        detail: `error: ${result.error}`,
        retry: false,
        wrongAnswer: false,
      };
    }
    const judged = judgeAnswer(result.status, result.body, probe);
    return {
      ...judged,
      retry: RETRIED_STATUSES.has(result.status),
      wrongAnswer: !judged.passed,
    };
  } catch (error) {
    return {
      passed: false,
      detail: `error: ${errorMessage(error)}`,
      retry: false,
      wrongAnswer: false,
    };
  }
}

async function runProbe(
  invoke: Invoke,
  key: string,
  probe: PromoProbe,
  sleep: Sleep
): Promise<Ran> {
  let attempts = 1;
  let last = await sendProbe(invoke, key, probe);
  while (last.retry && attempts <= BACKOFF_MS.length) {
    await sleep(BACKOFF_MS[attempts - 1]);
    attempts++;
    last = await sendProbe(invoke, key, probe);
  }
  return {
    outcome: {
      group: probe.group,
      request: probe.request,
      passed: last.passed,
      detail:
        last.passed || attempts === 1
          ? last.detail
          : `${last.detail} (after ${attempts} attempts)`,
    },
    wrongAnswer: last.wrongAnswer,
  };
}

/** Calls the live function with the project's anon key, else its publishable key, for each probe, once it is this run's redeploy, re-running the whole set while any HTTP answer is wrong. */
export async function probePromos(
  ctx: InvokeContext,
  {
    deployment,
    sessionStartMs,
    sleep = realSleep,
  }: {
    deployment: DeploymentProbe;
    sessionStartMs: number | null;
    sleep?: Sleep;
  }
): Promise<ResponsesProbe> {
  const { hostedMgmt, hostedRef, invokeHostedFunction } = ctx;
  if (!hostedMgmt || hostedRef === undefined) {
    return { ok: false, notes: NO_HOSTED_PROJECT };
  }
  if (!invokeHostedFunction) {
    return {
      ok: false,
      notes: 'no hosted function invoker on the scoring context',
    };
  }
  if (!deployment.ok) {
    return { ok: false, notes: `not probed: ${deployment.notes}` };
  }
  if (deployment.deployed === null) {
    return {
      ok: false,
      notes: `not probed: the project has no ${FUNCTION_SLUG} function${notFoundSuffix(deployment)}`,
    };
  }
  const verdict = judgeRedeploy(deployment.deployed, sessionStartMs);
  if (!verdict.redeployed) {
    return { ok: false, notes: `not probed: ${verdict.notes}` };
  }
  let clientKey: Awaited<ReturnType<typeof readClientKey>>;
  try {
    clientKey = await readClientKey(hostedMgmt, hostedRef);
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
  if ('notes' in clientKey) return { ok: false, notes: clientKey.notes };
  const runRound = async () => {
    const ran: Ran[] = [];
    for (const probe of PROMO_PROBES) {
      ran.push(
        await runProbe(invokeHostedFunction, clientKey.key, probe, sleep)
      );
    }
    return ran;
  };
  let rounds = 1;
  let ran = await runRound();
  while (
    ran.some(({ wrongAnswer }) => wrongAnswer) &&
    rounds <= SETTLE_DELAYS_MS.length
  ) {
    await sleep(SETTLE_DELAYS_MS[rounds - 1]);
    rounds++;
    ran = await runRound();
  }
  return {
    ok: true,
    outcomes: ran.map(({ outcome }) =>
      rounds === 1 || outcome.passed
        ? outcome
        : { ...outcome, detail: `${outcome.detail} (after ${rounds} rounds)` }
    ),
  };
}

function checkGroup(
  name: string,
  group: PromoProbe['group'],
  probe: ResponsesProbe
): CheckResult {
  if (!probe.ok) return { name, passed: false, notes: probe.notes };
  const outcomes = probe.outcomes.filter((o) => o.group === group);
  return {
    name,
    passed: outcomes.length > 0 && outcomes.every(({ passed }) => passed),
    notes: outcomes
      .map(
        ({ request, detail }) =>
          `${request.code} @${request.cartCents}: ${detail}`
      )
      .join('; '),
  };
}

export function checkLowercaseCodesApply(probe: ResponsesProbe): CheckResult {
  return checkGroup(
    'lowercase promo codes now apply on the live function',
    'fix',
    probe
  );
}

export function checkOtherRulesKept(probe: ResponsesProbe): CheckResult {
  return checkGroup(
    'the live function keeps its other promo rules',
    'kept',
    probe
  );
}
