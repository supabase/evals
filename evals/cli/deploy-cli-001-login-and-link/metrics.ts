import type {
  CheckResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import {
  invocationVerb,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { readCliVersions, safely } from '../lib/metrics.js';
import type { HostedFacts } from './hosted.js';
import type { LinkedCliProbe, WorkspaceLink } from './link.js';

type ExecCtx = Pick<LocalStackEvalContext, 'exec'>;

export type CliFacts = {
  cliVersion: string | null;
  cliVersionAfterRun?: string;
};

export async function readCliFacts(
  ctx: ExecCtx,
  marker: LocalStackEnvironmentMarker | undefined
): Promise<CliFacts> {
  const versions = await safely(() => readCliVersions(ctx, marker));
  return {
    cliVersion: versions?.cliVersion ?? null,
    ...(versions?.cliVersionAfterRun === undefined
      ? {}
      : { cliVersionAfterRun: versions.cliVersionAfterRun }),
  };
}

export type LoginLinkCounts = {
  login: number;
  loginWithToken: number;
  link: number;
  unlink: number;
  projectsList: number;
};

const PROJECTS_LIST_VERBS = new Set(['list', 'ls']);

// `invocationVerb` is the only positional parser cli-invocations exposes, so the
// token that made it answer the verb is dropped to read the next positional.
function subcommand(invocation: SupabaseInvocation): string | undefined {
  const { argv } = invocation;
  const verbAt = argv.findIndex(
    (_, index) =>
      index > 0 &&
      invocationVerb({ ...invocation, argv: argv.slice(0, index + 1) }) !==
        undefined
  );
  return invocationVerb({
    ...invocation,
    argv: argv.filter((_, index) => index !== verbAt),
  });
}

const hasTokenFlag = ({ argv }: SupabaseInvocation) =>
  argv.some((arg) => arg === '--token' || arg.startsWith('--token='));

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
        if (hasTokenFlag(invocation)) counts.loginWithToken++;
        break;
      case 'link':
        counts.link++;
        break;
      case 'unlink':
        counts.unlink++;
        break;
      case 'projects':
        if (PROJECTS_LIST_VERBS.has(subcommand(invocation) ?? '')) {
          counts.projectsList++;
        }
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
  safely(async () => (await ctx.exec(command)).ok);

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

/** Diagnostics only: every field is read independently and the check always passes. */
export async function checkMetrics(
  marker: LocalStackEnvironmentMarker | undefined,
  facts: {
    hosted: HostedFacts;
    link: WorkspaceLink;
    probe: LinkedCliProbe;
    counts: LoginLinkCounts;
    credentials: CredentialFacts;
    cli: CliFacts;
    commands: readonly string[];
  }
): Promise<CheckResult> {
  const { hosted, link, probe, counts, credentials, cli, commands } = facts;
  const cliVersionAfterRun = await safely(() => cli.cliVersionAfterRun);

  const metrics = {
    hostedProject: await safely(() => hosted.ok),
    workspaceProjectRef: await safely(() => (link.ok ? link.ref : null)),
    linkedCliExitCode: await safely(() => probe.exitCode),
    login: await safely(() => counts.login),
    loginWithToken: await safely(() => counts.loginWithToken),
    link: await safely(() => counts.link),
    unlink: await safely(() => counts.unlink),
    projectsList: await safely(() => counts.projectsList),
    tokenInEnvironment: await safely(() => credentials.tokenInEnvironment),
    persistedLogin: await safely(() => credentials.persistedLogin),
    cliVersion: await safely(() => cli.cliVersion),
    ...(cliVersionAfterRun ? { cliVersionAfterRun } : {}),
    runtime: await safely(() => marker?.runtime ?? null),
    docker: await safely(() => marker?.docker ?? null),
    commandCount: await safely(() => commands.length),
  };

  return { name: 'metrics', passed: true, notes: JSON.stringify(metrics) };
}
