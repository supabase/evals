import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { errorMessage, truncate } from '../lib/shell.js';
import { FUNCTION_SLUG } from './seed.js';

export type DeployedFunction = {
  status: string;
  verifyJwt: boolean | undefined;
  version: number | undefined;
};

export type DeploymentProbe =
  | { ok: true; deployed: DeployedFunction | null }
  | { ok: false; notes: string };

type HostedContext = Pick<LocalStackEvalContext, 'hostedMgmt' | 'hostedRef'>;

export const NO_HOSTED_PROJECT =
  'no hosted project on the scoring context: this eval needs `hostedProject: true` and a CLI experiment that links one';

export function hasHostedProject(ctx: HostedContext): boolean {
  return ctx.hostedMgmt !== undefined && ctx.hostedRef !== undefined;
}

export function checkHostedProject(ctx: HostedContext): CheckResult {
  const name = 'hosted project was provisioned for the run';
  return hasHostedProject(ctx)
    ? { name, passed: true, notes: `hosted project ${ctx.hostedRef}` }
    : { name, passed: false, notes: NO_HOSTED_PROJECT };
}

export async function readDeployment(
  ctx: HostedContext
): Promise<DeploymentProbe> {
  const { hostedMgmt, hostedRef } = ctx;
  if (!hostedMgmt || hostedRef === undefined) {
    return { ok: false, notes: NO_HOSTED_PROJECT };
  }
  try {
    const res = await hostedMgmt.GET(
      '/v1/projects/{ref}/functions/{function_slug}',
      { params: { path: { ref: hostedRef, function_slug: FUNCTION_SLUG } } }
    );
    if (res.response.status === 404) return { ok: true, deployed: null };
    if (res.error || !res.data) {
      return {
        ok: false,
        notes: `could not read the function: status ${res.response.status} ${truncate(JSON.stringify(res.error ?? null), 200)}`,
      };
    }
    return {
      ok: true,
      deployed: {
        status: res.data.status,
        verifyJwt: res.data.verify_jwt,
        version: res.data.version,
      },
    };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

export function checkFunctionDeployed(
  deployment: DeploymentProbe
): CheckResult {
  const name = `the ${FUNCTION_SLUG} function is deployed to the project`;
  if (!deployment.ok) return { name, passed: false, notes: deployment.notes };
  const { deployed } = deployment;
  if (deployed === null) {
    return {
      name,
      passed: false,
      notes: `not deployed: the project has no ${FUNCTION_SLUG} function`,
    };
  }
  return {
    name,
    passed: deployed.status === 'ACTIVE',
    notes: `status ${deployed.status}${deployed.version === undefined ? '' : ` (version ${deployed.version})`}`,
  };
}

export function checkJwtVerificationKept(
  deployment: DeploymentProbe
): CheckResult {
  const name = 'JWT verification is still on for the deployed function';
  if (!deployment.ok) return { name, passed: false, notes: deployment.notes };
  const { deployed } = deployment;
  if (deployed === null) return { name, passed: false, notes: 'not deployed' };
  if (deployed.verifyJwt === true) return { name, passed: true };
  return {
    name,
    passed: false,
    notes:
      deployed.verifyJwt === false
        ? 'verify_jwt is off: the project config keeps it on'
        : 'verify_jwt not reported by the API',
  };
}

/** The `- deployment:` and `- JWT verification` ground-truth lines the judge inputs share. */
export function describeDeployment(deployment: DeploymentProbe): string[] {
  const deployed = deployment.ok ? deployment.deployed : null;
  const summary = !deployment.ok
    ? `unavailable (${deployment.notes})`
    : deployed === null
      ? 'not deployed'
      : `${deployed.status}${deployed.version === undefined ? '' : ` v${deployed.version}`}`;
  const jwt =
    deployed?.verifyJwt === undefined
      ? 'unknown'
      : deployed.verifyJwt
        ? 'on'
        : 'off';
  return [
    `- deployment: ${summary}`,
    `- JWT verification on the deployed function: ${jwt}`,
  ];
}
