import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { NO_HOSTED_PROJECT } from '../lib/hosted.js';
import { errorMessage, truncate } from '../lib/shell.js';
import { REQUIRED_MIN_PASSWORD_LENGTH } from './config.js';

export const HOSTED_CHECK_NAME = 'a hosted project is available to push to';
export const PROJECT_POLICY_CHECK_NAME = `the project requires passwords of at least ${REQUIRED_MIN_PASSWORD_LENGTH} characters`;

export type ProjectPasswordPolicy =
  | { ok: true; minPasswordLength: number | null }
  | { ok: false; notes: string };

export async function readProjectPasswordPolicy(
  ctx: Pick<LocalStackEvalContext, 'hostedRef' | 'hostedMgmt'>
): Promise<ProjectPasswordPolicy> {
  const { hostedMgmt, hostedRef } = ctx;
  if (!hostedMgmt || !hostedRef) return { ok: false, notes: NO_HOSTED_PROJECT };
  try {
    const res = await hostedMgmt.GET('/v1/projects/{ref}/config/auth', {
      params: { path: { ref: hostedRef } },
    });
    if (res.error || !res.data) {
      return {
        ok: false,
        notes: `could not read the auth config: status ${res.response.status} ${truncate(JSON.stringify(res.error ?? null), 200)}`,
      };
    }
    return {
      ok: true,
      minPasswordLength: res.data.password_min_length ?? null,
    };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

export function checkProjectPasswordPolicy(
  policy: ProjectPasswordPolicy
): CheckResult {
  const name = PROJECT_POLICY_CHECK_NAME;
  if (!policy.ok) return { name, passed: false, notes: policy.notes };
  if (policy.minPasswordLength === REQUIRED_MIN_PASSWORD_LENGTH) {
    return { name, passed: true };
  }
  return {
    name,
    passed: false,
    notes:
      policy.minPasswordLength === null
        ? 'password_min_length is not set on the project'
        : `password_min_length is ${policy.minPasswordLength}, not ${REQUIRED_MIN_PASSWORD_LENGTH}`,
  };
}
