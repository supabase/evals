import type {
  CheckResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import {
  invocationFlag,
  invocationPositionals,
  invocationVerb,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { safely, type readCliVersions } from '../lib/metrics.js';
import type { HostedFacts } from './hosted.js';
import type { LinkedCliProbe, WorkspaceLink } from './link.js';

type ExecCtx = Pick<LocalStackEvalContext, 'exec'>;

export type LoginLinkCounts = {
  login: number;
  loginWithToken: number;
  link: number;
  unlink: number;
  projectsList: number;
};

const PROJECTS_LIST_VERBS = new Set(['list', 'ls']);

const isProjectsList = (invocation: SupabaseInvocation) =>
  invocationVerb(invocation) === 'projects' &&
  PROJECTS_LIST_VERBS.has(invocationPositionals(invocation)[1] ?? '');

export function countLoginLinkInvocations(
  invocations: readonly SupabaseInvocation[]
): LoginLinkCounts {
  const counts: LoginLinkCounts = {
    login: 0,
    loginWithToken: 0,
    link: 0,
    unlink: 0,
    projectsList: 0,
  };
  for (const invocation of invocations) {
    switch (invocationVerb(invocation)) {
      case 'login':
        counts.login++;
        if (invocationFlag(invocation, '--token') !== undefined) {
          counts.loginWithToken++;
        }
        break;
      case 'link':
        counts.link++;
        break;
      case 'unlink':
        counts.unlink++;
        break;
      case 'projects':
        if (isProjectsList(invocation)) counts.projectsList++;
        break;
    }
  }
  return counts;
}

export type CredentialFacts = {
  tokenInEnvironment: boolean | null;
  persistedLogin: boolean | null;
};

const probeSucceeds = (ctx: ExecCtx, command: string) =>
  safely(async () => {
    const { exitCode } = await ctx.exec(command);
    return exitCode === 0 ? true : exitCode === 1 ? false : null;
  });

export async function readCredentialFacts(
  ctx: ExecCtx
): Promise<CredentialFacts> {
  return {
    tokenInEnvironment: await probeSucceeds(
      ctx,
      'test -n "$SUPABASE_ACCESS_TOKEN"'
    ),
    persistedLogin: await probeSucceeds(
      ctx,
      'test -s "${SUPABASE_HOME:-$HOME/.supabase}/access-token"'
    ),
  };
}

type CliVersions = Awaited<ReturnType<typeof readCliVersions>>;

/** Diagnostics only: the check always passes. */
export function checkMetrics(
  marker: LocalStackEnvironmentMarker | undefined,
  facts: {
    hosted: HostedFacts;
    link: WorkspaceLink;
    probe: LinkedCliProbe;
    counts: LoginLinkCounts;
    credentials: CredentialFacts;
    cli: CliVersions;
    commands: readonly string[];
  }
): CheckResult {
  const { hosted, link, probe, counts, credentials, cli, commands } = facts;

  const metrics = {
    hostedProject: hosted.ok,
    workspaceProjectRef: link.ok ? link.ref : null,
    linkedCliExitCode: probe.exitCode,
    ...counts,
    ...credentials,
    ...cli,
    runtime: marker?.runtime ?? null,
    docker: marker?.docker ?? null,
    commandCount: commands.length,
  };

  return { name: 'metrics', passed: true, notes: JSON.stringify(metrics) };
}
