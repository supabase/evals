import { createHash } from 'node:crypto';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { errorMessage, truncate } from '../lib/shell.js';
import {
  DEVELOPMENT_VALUES,
  PRODUCTION_VALUES,
  SECRET_NAMES,
  type SecretName,
} from './seed.js';

type HostedContext = Pick<LocalStackEvalContext, 'hostedMgmt' | 'hostedRef'>;

export const NO_HOSTED_PROJECT =
  'no hosted project on the scoring context: this eval needs `hostedProject: true` and a CLI experiment that links one';

export const HOSTED_CHECK_NAME = 'hosted project was provisioned for the run';

export const VALUES_CHECK_NAME =
  'the project holds the production value of every function secret';

export function hasHostedProject(ctx: HostedContext): boolean {
  return ctx.hostedMgmt !== undefined && ctx.hostedRef !== undefined;
}

export function checkHostedProject(ctx: HostedContext): CheckResult {
  const name = HOSTED_CHECK_NAME;
  return hasHostedProject(ctx)
    ? { name, passed: true, notes: `hosted project ${ctx.hostedRef}` }
    : { name, passed: false, notes: NO_HOSTED_PROJECT };
}

export type ProjectSecret = { name: string; value: string };

export type SecretsProbe =
  | { ok: true; secrets: ProjectSecret[] }
  | { ok: false; notes: string };

/** Lists the project's secrets through the Management API; the API's `value` is a digest, never plaintext. */
export async function readProjectSecrets(
  ctx: HostedContext
): Promise<SecretsProbe> {
  const { hostedMgmt, hostedRef } = ctx;
  if (!hostedMgmt || hostedRef === undefined) {
    return { ok: false, notes: NO_HOSTED_PROJECT };
  }
  try {
    const res = await hostedMgmt.GET('/v1/projects/{ref}/secrets', {
      params: { path: { ref: hostedRef } },
    });
    if (res.error || !res.data) {
      return {
        ok: false,
        notes: `could not list the project's secrets: status ${res.response.status} ${truncate(JSON.stringify(res.error ?? null), 200)}`,
      };
    }
    return {
      ok: true,
      secrets: res.data.map(({ name, value }) => ({ name, value })),
    };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

export type SecretState = 'production' | 'development' | 'other' | 'missing';

const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

const holds = (value: string, seeded: string) =>
  value === seeded || value.toLowerCase() === sha256(seeded);

function stateOf(name: SecretName, values: readonly string[]): SecretState {
  if (values.length === 0) return 'missing';
  const isProduction = (value: string) => holds(value, PRODUCTION_VALUES[name]);
  if (values.every(isProduction)) return 'production';
  return values.some((value) => holds(value, DEVELOPMENT_VALUES[name]))
    ? 'development'
    : 'other';
}

/** What each seeded name holds on the project, matching the API's digest (or plaintext) against the two env files; names outside the seed are ignored. */
export function secretStates(
  secrets: readonly ProjectSecret[]
): Record<SecretName, SecretState> {
  return Object.fromEntries(
    SECRET_NAMES.map((name) => [
      name,
      stateOf(
        name,
        secrets.filter((secret) => secret.name === name).map((s) => s.value)
      ),
    ])
  ) as Record<SecretName, SecretState>;
}

const STATE_NOTES: Record<SecretState, string> = {
  production: 'holds the production value',
  development: 'holds the development value',
  other: 'holds a value from neither env file',
  missing: 'not set',
};

export function checkProductionValues(probe: SecretsProbe): CheckResult {
  const name = VALUES_CHECK_NAME;
  if (!probe.ok) return { name, passed: false, notes: probe.notes };
  const states = secretStates(probe.secrets);
  const wrong = SECRET_NAMES.filter((n) => states[n] !== 'production');
  if (wrong.length === 0) return { name, passed: true };
  return {
    name,
    passed: false,
    notes: wrong.map((n) => `${n}: ${STATE_NOTES[states[n]]}`).join('; '),
  };
}

/** Ground-truth line for the report judge: what each seeded name holds, never a value or digest. */
export function describeSecrets(probe: SecretsProbe): string[] {
  if (!probe.ok) {
    return [`- secrets on the project: unavailable (${probe.notes})`];
  }
  const states = secretStates(probe.secrets);
  return [
    `- secrets on the project after the run: ${SECRET_NAMES.map((n) => `${n} ${STATE_NOTES[states[n]]}`).join('; ')}`,
  ];
}
