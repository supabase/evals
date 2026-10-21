import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';

/** Whether the run has a hosted project, with the reason when it doesn't. */
export type HostedFacts =
  | { ok: true; ref: string }
  | { ok: false; notes: string };

export const NO_HOSTED_PROJECT =
  'no hosted project in CI until the staging org lands (CLI-2754)';

export function readHostedFacts(
  ctx: Pick<LocalStackEvalContext, 'hostedRef' | 'hostedMgmt'>
): HostedFacts {
  return ctx.hostedRef && ctx.hostedMgmt
    ? { ok: true, ref: ctx.hostedRef }
    : { ok: false, notes: NO_HOSTED_PROJECT };
}

export function checkHostedProject(
  hosted: HostedFacts,
  name: string
): CheckResult {
  return hosted.ok
    ? { name, passed: true }
    : { name, passed: false, notes: hosted.notes };
}
