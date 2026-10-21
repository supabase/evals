import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { parse } from 'smol-toml';
import { describeFailure, errorMessage } from '../lib/shell.js';

export const CONFIG_PATH = 'supabase/config.toml';
export const REQUIRED_MIN_PASSWORD_LENGTH = 10;
export const REPO_POLICY_CHECK_NAME = `the repo's Supabase config requires passwords of at least ${REQUIRED_MIN_PASSWORD_LENGTH} characters`;

export type RepoPasswordPolicy =
  | { ok: true; minPasswordLength: unknown }
  | { ok: false; notes: string };

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads `auth.minimum_password_length` from the TOML text; a TOML parse error, including an integer outside the safe range, makes it not ok. */
export function parsePasswordPolicy(text: string): RepoPasswordPolicy {
  try {
    const { auth } = parse(text);
    return {
      ok: true,
      minPasswordLength: isTable(auth)
        ? auth.minimum_password_length
        : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      notes: `${CONFIG_PATH} does not parse: ${errorMessage(error)}`,
    };
  }
}

export async function readRepoPasswordPolicy(
  ctx: Pick<LocalStackEvalContext, 'exec'>
): Promise<RepoPasswordPolicy> {
  try {
    const result = await ctx.exec(`cat ${CONFIG_PATH}`);
    if (result.ok) return parsePasswordPolicy(result.stdout);
    if (result.stderr.includes('No such file or directory')) {
      return { ok: false, notes: `${CONFIG_PATH} is missing` };
    }
    return {
      ok: false,
      notes: `could not read ${CONFIG_PATH} (${describeFailure(result)})`,
    };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

export function checkRepoPasswordPolicy(
  policy: RepoPasswordPolicy
): CheckResult {
  const name = REPO_POLICY_CHECK_NAME;
  if (!policy.ok) return { name, passed: false, notes: policy.notes };
  const value = policy.minPasswordLength;
  if (value === REQUIRED_MIN_PASSWORD_LENGTH) return { name, passed: true };
  if (value === undefined) {
    return {
      name,
      passed: false,
      notes: `auth.minimum_password_length is not set in ${CONFIG_PATH}`,
    };
  }
  if (typeof value === 'number') {
    return {
      name,
      passed: false,
      notes: `auth.minimum_password_length is ${value}, not ${REQUIRED_MIN_PASSWORD_LENGTH}`,
    };
  }
  return {
    name,
    passed: false,
    notes: `auth.minimum_password_length is ${JSON.stringify(value)}, which is not a number`,
  };
}
