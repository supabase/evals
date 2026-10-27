import type {
  CheckResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import {
  invocationSubcommand,
  invocationVerb,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { type readCliVersions, safely } from '../lib/metrics.js';
import { describeKeyValue, KEY_VAR, URL_VAR, urlHostname } from './config.js';
import type { AppEnv } from './env-files.js';
import type { HostedFacts } from './hosted.js';
import type { SecretExposureProbe } from './secrets.js';

export type ApiKeyCounts = {
  projectsList: number;
  projectsApiKeys: number;
  projectsApiKeysReveal: number;
  link: number;
  login: number;
  bootstrap: number;
};

const REVEAL_FLAG = /^--reveal(=(true|1|t))?$/i;

const isReveal = (invocation: SupabaseInvocation) =>
  invocation.argv.some((arg) => REVEAL_FLAG.test(arg));

export function countApiKeyInvocations(
  invocations: readonly SupabaseInvocation[]
): ApiKeyCounts {
  const counts: ApiKeyCounts = {
    projectsList: 0,
    projectsApiKeys: 0,
    projectsApiKeysReveal: 0,
    link: 0,
    login: 0,
    bootstrap: 0,
  };
  for (const invocation of invocations) {
    switch (invocationVerb(invocation)) {
      case 'projects': {
        const subcommand = invocationSubcommand(invocation);
        if (subcommand === 'list' || subcommand === 'ls') {
          counts.projectsList++;
        } else if (subcommand === 'api-keys') {
          counts.projectsApiKeys++;
          if (isReveal(invocation)) counts.projectsApiKeysReveal++;
        }
        break;
      }
      case 'link':
        counts.link++;
        break;
      case 'login':
        counts.login++;
        break;
      case 'bootstrap':
        counts.bootstrap++;
        break;
    }
  }
  return counts;
}

/** Whether `SUPABASE_ACCESS_TOKEN` is non-empty in the sandbox, or null when the probe could not tell. */
export function readTokenInEnvironment(
  ctx: Pick<LocalStackEvalContext, 'exec'>
): Promise<boolean | null> {
  return safely(async () => {
    const { exitCode } = await ctx.exec('test -n "$SUPABASE_ACCESS_TOKEN"');
    return exitCode === 0 ? true : exitCode === 1 ? false : null;
  });
}

type CliVersions = Awaited<ReturnType<typeof readCliVersions>>;

/** Diagnostics only: the check always passes. */
export function checkMetrics(
  marker: LocalStackEnvironmentMarker | undefined,
  facts: {
    hosted: HostedFacts;
    env: AppEnv;
    secrets: SecretExposureProbe;
    counts: ApiKeyCounts;
    tokenInEnvironment: boolean | null;
    cli: CliVersions;
    commands: readonly string[];
  }
): CheckResult {
  const { hosted, env, secrets, counts, tokenInEnvironment, cli, commands } =
    facts;

  const metrics = {
    hostedProject: hosted.ok,
    ...counts,
    tokenInEnvironment,
    envFiles: env.ok ? env.files : null,
    urlHost: env.ok ? (urlHostname(env.values[URL_VAR]?.value) ?? null) : null,
    keyKind: env.ok
      ? describeKeyValue(hosted, env.values[KEY_VAR]?.value)
      : null,
    secretsStoredPrivately: secrets.ok ? secrets.storedPrivately.length : null,
    ...cli,
    runtime: marker?.runtime ?? null,
    docker: marker?.docker ?? null,
    commandCount: commands.length,
  };

  return { name: 'metrics', passed: true, notes: JSON.stringify(metrics) };
}
