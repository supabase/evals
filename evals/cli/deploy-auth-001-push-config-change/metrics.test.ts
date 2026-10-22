// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-auth-001-push-config-change
import type { LocalStackEnvironmentMarker } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import { extractCommandEntries } from '../lib/detours.js';
import {
  FAKE_ACCESS_TOKEN,
  HOSTED_ABSENT,
  HOSTED_OK,
  HOSTED_REF,
  shellCall,
} from './fixtures.js';
import {
  type ConfigCounts,
  checkMetrics,
  countConfigInvocations,
} from './metrics.js';

const MARKER: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'beta',
  cliVersion: '2.117.0',
  docker: 'available',
  sessionStartedMs: 1_000,
};

const ZERO_COUNTS: ConfigCounts = {
  configPush: 0,
  configPushWithYes: 0,
  configDiff: 0,
  configPull: 0,
  link: 0,
  login: 0,
};

const metricsOf = (check: { notes?: string }) =>
  JSON.parse(check.notes ?? '{}') as Record<string, unknown>;

describe('countConfigInvocations', () => {
  const count = (...commands: string[]) =>
    countConfigInvocations(
      findSupabaseInvocations(extractCommandEntries(commands.map(shellCall)))
    );

  it('counts nothing when no supabase command ran', () => {
    expect(count()).toEqual(ZERO_COUNTS);
  });

  it('counts config push without --yes as a push only', () => {
    expect(count('supabase config push')).toEqual({
      ...ZERO_COUNTS,
      configPush: 1,
    });
  });

  it('counts config push --yes as a push with --yes', () => {
    expect(count('supabase config push --yes')).toEqual({
      ...ZERO_COUNTS,
      configPush: 1,
      configPushWithYes: 1,
    });
  });

  it('counts a global --yes written before the verb as a push with --yes', () => {
    expect(count('supabase --yes config push')).toEqual({
      ...ZERO_COUNTS,
      configPush: 1,
      configPushWithYes: 1,
    });
  });

  it('counts npx supabase config push with a project ref and --yes', () => {
    expect(
      count(`npx supabase config push --project-ref ${HOSTED_REF} --yes`)
    ).toEqual({ ...ZERO_COUNTS, configPush: 1, configPushWithYes: 1 });
  });

  it('counts --yes=true as a push with --yes', () => {
    expect(count('supabase config push --yes=true')).toEqual({
      ...ZERO_COUNTS,
      configPush: 1,
      configPushWithYes: 1,
    });
  });

  it('does not count --yes=false as a push with --yes', () => {
    expect(count('supabase config push --yes=false')).toEqual({
      ...ZERO_COUNTS,
      configPush: 1,
    });
  });

  it('does not count a push fed its answer on stdin as a push with --yes', () => {
    expect(count('yes | supabase config push')).toEqual({
      ...ZERO_COUNTS,
      configPush: 1,
    });
  });

  it('counts config diff as a diff, not a push', () => {
    expect(count('supabase config diff')).toEqual({
      ...ZERO_COUNTS,
      configDiff: 1,
    });
  });

  it('counts config pull as a pull, not a push', () => {
    expect(count('supabase config pull')).toEqual({
      ...ZERO_COUNTS,
      configPull: 1,
    });
  });

  it('counts supabase link --project-ref as a link', () => {
    expect(count('supabase link --project-ref x')).toEqual({
      ...ZERO_COUNTS,
      link: 1,
    });
  });

  it('counts supabase login --token as a login', () => {
    expect(count(`supabase login --token ${FAKE_ACCESS_TOKEN}`)).toEqual({
      ...ZERO_COUNTS,
      login: 1,
    });
  });

  it('does not count a command that only echoes a supabase command line', () => {
    expect(count('echo "supabase config push"')).toEqual(ZERO_COUNTS);
  });

  it('does not count a push that only asked for help', () => {
    expect(count('supabase config push --help')).toEqual(ZERO_COUNTS);
  });

  it('does not count other push verbs as a config push', () => {
    expect(
      count(
        'supabase db push --yes',
        'supabase functions deploy',
        'supabase secrets set A=b'
      )
    ).toEqual(ZERO_COUNTS);
  });

  it('counts every invocation of a chained command and across commands', () => {
    expect(
      count(
        `supabase link --project-ref ${HOSTED_REF} && supabase config diff && supabase config push --yes`,
        'supabase config push',
        'supabase config pull',
        `supabase login --token ${FAKE_ACCESS_TOKEN}`
      )
    ).toEqual({
      configPush: 2,
      configPushWithYes: 1,
      configDiff: 1,
      configPull: 1,
      link: 1,
      login: 1,
    });
  });
});

describe('checkMetrics', () => {
  const FACTS = {
    hosted: HOSTED_OK,
    repo: {
      ok: true as const,
      minPasswordLength: 6 as unknown,
      conflictingRemotes: [],
    },
    project: { ok: true as const, minPasswordLength: 10 as number | null },
    counts: {
      configPush: 3,
      configPushWithYes: 2,
      configDiff: 4,
      configPull: 5,
      link: 6,
      login: 7,
    } satisfies ConfigCounts,
    cli: { cliVersion: '2.117.0' },
    commands: ['supabase config push', 'supabase config push --yes'],
  };

  it('carries every documented field of a full run and passes', () => {
    const check = checkMetrics(MARKER, FACTS);

    expect(check).toMatchObject({ name: 'metrics', passed: true });
    expect(metricsOf(check)).toEqual({
      hostedProject: true,
      repoMinPasswordLength: 6,
      projectMinPasswordLength: 10,
      configPush: 3,
      configPushWithYes: 2,
      configDiff: 4,
      configPull: 5,
      link: 6,
      login: 7,
      cliVersion: '2.117.0',
      runtime: 'local-stack',
      docker: 'available',
      commandCount: 2,
    });
  });

  it('passes with nulls and zeros when nothing worked', () => {
    const check = checkMetrics(undefined, {
      hosted: HOSTED_ABSENT,
      repo: { ok: false, notes: 'supabase/config.toml is missing' },
      project: { ok: false, notes: 'no hosted project' },
      counts: ZERO_COUNTS,
      cli: { cliVersion: null },
      commands: [],
    });

    expect(check).toMatchObject({ name: 'metrics', passed: true });
    expect(metricsOf(check)).toEqual({
      hostedProject: false,
      repoMinPasswordLength: null,
      projectMinPasswordLength: null,
      ...ZERO_COUNTS,
      cliVersion: null,
      runtime: null,
      docker: null,
      commandCount: 0,
    });
  });

  it('reports a null repo length when the key is unset in the config', () => {
    const metrics = metricsOf(
      checkMetrics(MARKER, {
        ...FACTS,
        repo: {
          ok: true,
          minPasswordLength: undefined,
          conflictingRemotes: [],
        },
      })
    );

    expect(metrics).toMatchObject({ repoMinPasswordLength: null });
  });

  it('reports the CLI version PATH resolved to after the run when it differs', () => {
    const check = checkMetrics(MARKER, {
      ...FACTS,
      cli: { cliVersion: '2.117.0', cliVersionAfterRun: '2.120.0' },
    });

    expect(metricsOf(check)).toMatchObject({
      cliVersion: '2.117.0',
      cliVersionAfterRun: '2.120.0',
    });
  });
});
