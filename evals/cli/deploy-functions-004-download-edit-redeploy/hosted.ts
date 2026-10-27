import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { errorMessage, truncate } from '../lib/shell.js';
import { FUNCTION_SLUG, SEEDED_VERSION } from './seed.js';

export type DeployedFunction = {
  status: string;
  verifyJwt: boolean | undefined;
  version: number | undefined;
  updatedAtMs?: number;
};

export type DeploymentProbe =
  | { ok: true; deployed: DeployedFunction | null; notFound?: string }
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
    if (res.response.status === 404) {
      const message = (res.error as { message?: unknown } | null | undefined)
        ?.message;
      return {
        ok: true,
        deployed: null,
        notFound:
          typeof message === 'string' && message !== ''
            ? `404: ${message}`
            : '404',
      };
    }
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
        updatedAtMs:
          typeof res.data.updated_at === 'number' &&
          Number.isFinite(res.data.updated_at)
            ? res.data.updated_at
            : undefined,
      },
    };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

export type Redeploy =
  | { redeployed: true }
  | { redeployed: false; notes: string };

/** A function counts as this run's redeploy only if it was updated after the session started and is past the seeded version. */
export function judgeRedeploy(
  deployed: DeployedFunction,
  sessionStartMs: number | null
): Redeploy {
  const cannotTie = (why: string): Redeploy => ({
    redeployed: false,
    notes: `the deployed ${FUNCTION_SLUG} can't be tied to this run: ${why}`,
  });
  if (sessionStartMs === null) {
    return cannotTie('session start time unavailable');
  }
  if (deployed.updatedAtMs === undefined) {
    return cannotTie('updated_at missing from the API response');
  }
  if (deployed.updatedAtMs < sessionStartMs) {
    return {
      redeployed: false,
      notes: `the deployed ${FUNCTION_SLUG} is still the deployment from before this run (updated ${new Date(deployed.updatedAtMs).toISOString()}, session started ${new Date(sessionStartMs).toISOString()})`,
    };
  }
  if (deployed.version === undefined) {
    return cannotTie('version missing from the API response');
  }
  if (deployed.version <= SEEDED_VERSION) {
    return {
      redeployed: false,
      notes: `the deployed ${FUNCTION_SLUG}'s version ${deployed.version} matches the seeded deployment, so this run's redeploy can't be told apart from the seed`,
    };
  }
  return { redeployed: true };
}

export function checkFunctionRedeployed(
  deployment: DeploymentProbe,
  sessionStartMs: number | null
): CheckResult {
  const name = `the ${FUNCTION_SLUG} function was redeployed during the run`;
  if (!deployment.ok) return { name, passed: false, notes: deployment.notes };
  const { deployed } = deployment;
  if (deployed === null) {
    return {
      name,
      passed: false,
      notes: `not deployed: the project has no ${FUNCTION_SLUG} function${notFoundSuffix(deployment)}`,
    };
  }
  const verdict = judgeRedeploy(deployed, sessionStartMs);
  if (!verdict.redeployed) return { name, passed: false, notes: verdict.notes };
  return {
    name,
    passed: deployed.status === 'ACTIVE',
    notes: `status ${deployed.status}${deployed.version === undefined ? '' : ` (version ${deployed.version})`}`,
  };
}

export function checkJwtVerificationKept(
  deployment: DeploymentProbe,
  sessionStartMs: number | null
): CheckResult {
  const name = 'JWT verification is still on for the redeployed function';
  if (!deployment.ok) return { name, passed: false, notes: deployment.notes };
  const { deployed } = deployment;
  if (deployed === null) return { name, passed: false, notes: 'not deployed' };
  const verdict = judgeRedeploy(deployed, sessionStartMs);
  if (!verdict.redeployed) return { name, passed: false, notes: verdict.notes };
  if (deployed.verifyJwt === true) return { name, passed: true };
  return {
    name,
    passed: false,
    notes:
      deployed.verifyJwt === false
        ? "verify_jwt is off: the deployed function had it on and the fix didn't ask to change it"
        : 'verify_jwt not reported by the API',
  };
}

export function notFoundSuffix(deployment: DeploymentProbe): string {
  return deployment.ok && deployment.notFound
    ? ` (${deployment.notFound})`
    : '';
}

/** The `- deployment:` and `- JWT verification` ground-truth lines for the report judge. */
export function describeDeployment(
  deployment: DeploymentProbe,
  sessionStartMs: number | null
): string[] {
  const deployed = deployment.ok ? deployment.deployed : null;
  const verdict =
    deployed === null ? null : judgeRedeploy(deployed, sessionStartMs);
  const stale = verdict?.redeployed === false ? `; ${verdict.notes}` : '';
  const summary = !deployment.ok
    ? `unavailable (${deployment.notes})`
    : deployed === null
      ? `not deployed${notFoundSuffix(deployment)}`
      : `${deployed.status}${deployed.version === undefined ? '' : ` v${deployed.version}`}${stale}`;
  const jwt = !deployment.ok
    ? 'n/a (deployment unavailable)'
    : deployed === null
      ? 'n/a (not deployed)'
      : deployed.verifyJwt === undefined
        ? 'unknown'
        : deployed.verifyJwt
          ? 'on'
          : 'off';
  return [
    `- deployment: ${summary}`,
    `- JWT verification on the deployed function: ${jwt}`,
  ];
}
