import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';

export const HOSTED_CHECK_NAME = 'a hosted project is available to link';

export type HostedFacts =
  | { ok: true; ref: string }
  | { ok: false; notes: string };

const NO_HOSTED_PROJECT =
  'no hosted project in CI until the staging org lands (CLI-2754): the run has nothing to link to';

export function readHostedFacts(
  ctx: Pick<LocalStackEvalContext, 'hostedRef' | 'hostedMgmt'>
): HostedFacts {
  return ctx.hostedRef && ctx.hostedMgmt
    ? { ok: true, ref: ctx.hostedRef }
    : { ok: false, notes: NO_HOSTED_PROJECT };
}

export function checkHostedProject(hosted: HostedFacts): CheckResult {
  return hosted.ok
    ? { name: HOSTED_CHECK_NAME, passed: true }
    : { name: HOSTED_CHECK_NAME, passed: false, notes: hosted.notes };
}
