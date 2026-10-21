import type {
  CheckResult,
  LocalStackEnvironmentMarker,
} from '@supabase-evals/core';
import {
  invocationSubcommand,
  invocationVerb,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import type { HostedFacts } from '../lib/hosted.js';
import type { readCliVersions } from '../lib/metrics.js';
import type { RepoPasswordPolicy } from './config.js';
import type { ProjectPasswordPolicy } from './hosted.js';

export type ConfigCounts = {
  configPush: number;
  configPushWithYes: number;
  configDiff: number;
  configPull: number;
  link: number;
  login: number;
};

const hasYes = (invocation: SupabaseInvocation) =>
  invocation.argv.some((word) => word === '--yes' || word === '--yes=true');

export function countConfigInvocations(
  invocations: readonly SupabaseInvocation[]
): ConfigCounts {
  const counts: ConfigCounts = {
    configPush: 0,
    configPushWithYes: 0,
    configDiff: 0,
    configPull: 0,
    link: 0,
    login: 0,
  };
  for (const invocation of invocations) {
    switch (invocationVerb(invocation)) {
      case 'config':
        switch (invocationSubcommand(invocation)) {
          case 'push':
            counts.configPush++;
            if (hasYes(invocation)) counts.configPushWithYes++;
            break;
          case 'diff':
            counts.configDiff++;
            break;
          case 'pull':
            counts.configPull++;
            break;
        }
        break;
      case 'link':
        counts.link++;
        break;
      case 'login':
        counts.login++;
        break;
    }
  }
  return counts;
}

type CliVersions = Awaited<ReturnType<typeof readCliVersions>>;

/** Diagnostics only: the check always passes. */
export function checkMetrics(
  marker: LocalStackEnvironmentMarker | undefined,
  facts: {
    hosted: HostedFacts;
    repo: RepoPasswordPolicy;
    project: ProjectPasswordPolicy;
    counts: ConfigCounts;
    cli: CliVersions;
    commands: readonly string[];
  }
): CheckResult {
  const { hosted, repo, project, counts, cli, commands } = facts;

  const metrics = {
    hostedProject: hosted.ok,
    repoMinPasswordLength: repo.ok ? (repo.minPasswordLength ?? null) : null,
    projectMinPasswordLength: project.ok ? project.minPasswordLength : null,
    ...counts,
    ...cli,
    runtime: marker?.runtime ?? null,
    docker: marker?.docker ?? null,
    commandCount: commands.length,
  };

  return { name: 'metrics', passed: true, notes: JSON.stringify(metrics) };
}
