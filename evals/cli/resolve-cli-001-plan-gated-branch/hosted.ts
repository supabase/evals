import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';

type HostedContext = Pick<
  LocalStackEvalContext,
  'hostedMgmt' | 'hostedQuery' | 'hostedRef'
>;

export const NO_HOSTED_PROJECT =
  'no hosted project on the scoring context: this eval needs `hostedProject: true` and a CLI experiment that links one';

export function hasHostedProject(ctx: HostedContext): boolean {
  return (
    ctx.hostedMgmt !== undefined &&
    ctx.hostedQuery !== undefined &&
    ctx.hostedRef !== undefined
  );
}

export function checkHostedProject(ctx: HostedContext): CheckResult {
  const name = 'hosted project was provisioned for the run';
  return hasHostedProject(ctx)
    ? { name, passed: true, notes: `hosted project ${ctx.hostedRef}` }
    : { name, passed: false, notes: NO_HOSTED_PROJECT };
}
