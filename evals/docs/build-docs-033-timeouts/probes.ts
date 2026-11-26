import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { execSql } from '../lib/exec-sql.js';

export const CHECK = {
  reloaded: 'the Data API was reloaded after the role was changed',
  quick: "a visitor's quick query still finishes",
  cutOff: "a visitor's slow query is cut off within 2.5 seconds",
  job: "the nightly job's 4 second query still finishes",
} as const;

// The user asks for one second. Anon's default is 3 seconds, so anything the
// scorer sees cancelled by 2.5 seconds was set by the agent, and 2 seconds or
// 1.5 seconds pass as well.
const CUT_OFF_BY_MS = 2500;
const SLOW = 4;
const QUICK = 0.3;
const JOB = 4;

type Call = { status: number; code?: string; ms: number; body: string };

export type Probe =
  | { ok: false; reason: string }
  | {
      ok: true;
      quick: Call;
      /** The slow visitor call the cut-off check reads. */
      slow: Call;
      /** The slow visitor call before the scorer reloaded the Data API. */
      beforeReload: Call;
      reloadMadeTheDifference: boolean;
      job: Call;
      anonSetting: string;
    };

const short = (text: string) => text.replace(/\s+/g, ' ').slice(0, 160);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const finished = (call: Call) => call.status === 200 && call.body === '"done"';
const cut = (call: Call) => call.code === '57014' && call.ms < CUT_OFF_BY_MS;

/**
 * One round of calls to the function, as a visitor and as the server key,
 * through the Data API. The role settings only reach it after a reload, so a
 * visitor call that isn't cut off is repeated after the scorer reloads, and
 * the reload is what the lifecycle check reads.
 */
export async function probeTimeouts(
  ctx: LocalStackEvalContext
): Promise<Probe> {
  try {
    const stack = await ctx.stackStatus();
    const visitor = (seconds: number) =>
      call(stack.apiUrl, stack.publishableKey, seconds);
    const server = (seconds: number) =>
      call(stack.apiUrl, stack.secretKey, seconds);

    const quick = await visitor(QUICK);
    const beforeReload = await visitor(SLOW);
    let slow = beforeReload;
    let reloadMadeTheDifference = false;
    if (!cut(beforeReload)) {
      await execSql(ctx, "notify pgrst, 'reload config';");
      await sleep(1500);
      slow = await visitor(SLOW);
      reloadMadeTheDifference = cut(slow);
    }
    const job = await server(JOB);
    return {
      ok: true,
      quick,
      slow,
      beforeReload,
      reloadMadeTheDifference,
      job,
      anonSetting: await anonSetting(ctx),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: message.slice(0, 300) };
  }
}

async function call(
  apiUrl: string,
  key: string,
  seconds: number
): Promise<Call> {
  // A key in the new format is not a JWT, so it only goes in `apikey`.
  const headers: Record<string, string> = {
    apikey: key,
    'Content-Type': 'application/json',
  };
  if (key.split('.').length === 3) headers.Authorization = `Bearer ${key}`;
  let last: Call = { status: 0, ms: 0, body: 'no response' };
  // PostgREST answers 503 while it reloads its schema cache. The retries do
  // not count towards the time the call took.
  for (let attempt = 0; attempt < 6; attempt++) {
    const started = Date.now();
    try {
      const response = await fetch(`${apiUrl}/rest/v1/rpc/slow_report`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ pause_seconds: seconds }),
      });
      const text = await response.text();
      let code: string | undefined;
      try {
        code = JSON.parse(text)?.code;
      } catch {}
      last = {
        status: response.status,
        code,
        ms: Date.now() - started,
        body: short(text),
      };
    } catch (error) {
      last = {
        status: 0,
        ms: Date.now() - started,
        body: error instanceof Error ? error.message : String(error),
      };
    }
    if (last.status !== 503 && last.status !== 0) return last;
    await sleep(1000);
  }
  return last;
}

async function anonSetting(ctx: LocalStackEvalContext): Promise<string> {
  const { rows } = await ctx.query(
    "select rolconfig::text as config from pg_roles where rolname = 'anon';"
  );
  return String(rows[0]?.config ?? 'no setting');
}

function blocked(name: string, reason: string): CheckResult {
  return { name, passed: false, notes: `not run: ${reason}` };
}

// Passes when the reload made no difference: a project with no timeout set has
// nothing to reload, and its cut-off check carries the failure.
export function checkReloaded(probe: Probe): CheckResult {
  if (!probe.ok) return blocked(CHECK.reloaded, probe.reason);
  return {
    name: CHECK.reloaded,
    passed: !probe.reloadMadeTheDifference,
    notes: probe.reloadMadeTheDifference
      ? `the role's setting was not live in the Data API until the scorer reloaded it (anon: ${probe.anonSetting}); the first call ran ${probe.beforeReload.ms} ms`
      : cut(probe.beforeReload)
        ? `live without a reload (anon: ${probe.anonSetting})`
        : `nothing to reload: reloading changed nothing (anon: ${probe.anonSetting})`,
  };
}

// The control for the cut-off check: a visitor limited to nothing at all would
// pass it.
export function checkQuickFinishes(probe: Probe): CheckResult {
  if (!probe.ok) return blocked(CHECK.quick, probe.reason);
  return {
    name: CHECK.quick,
    passed: finished(probe.quick),
    notes: finished(probe.quick)
      ? `finished in ${probe.quick.ms} ms`
      : `${probe.quick.code ?? probe.quick.status} after ${probe.quick.ms} ms: ${probe.quick.body} (anon: ${probe.anonSetting})`,
  };
}

export function checkCutOff(probe: Probe): CheckResult {
  if (!probe.ok) return blocked(CHECK.cutOff, probe.reason);
  if (!finished(probe.quick)) {
    return blocked(
      CHECK.cutOff,
      `a quick visitor query did not finish (see "${CHECK.quick}")`
    );
  }
  return {
    name: CHECK.cutOff,
    passed: cut(probe.slow),
    notes: cut(probe.slow)
      ? `cancelled after ${probe.slow.ms} ms`
      : `${probe.slow.code ?? probe.slow.status} after ${probe.slow.ms} ms: ${probe.slow.body} (anon: ${probe.anonSetting})`,
  };
}

export function checkJobFinishes(probe: Probe): CheckResult {
  if (!probe.ok) return blocked(CHECK.job, probe.reason);
  return {
    name: CHECK.job,
    passed: finished(probe.job),
    notes: finished(probe.job)
      ? `finished in ${probe.job.ms} ms`
      : `${probe.job.code ?? probe.job.status} after ${probe.job.ms} ms: ${probe.job.body}`,
  };
}
