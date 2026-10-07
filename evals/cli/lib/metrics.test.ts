// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/lib
import type {
  CommandResult,
  LocalStackEnvironmentMarker,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  findSupabaseInvocations,
  listCliOverrides,
} from './cli-invocations.js';
import { readCliVersions, readStagedCliVersion } from './metrics.js';

const marker = (cliVersion: string): LocalStackEnvironmentMarker => ({
  runtime: 'local-stack',
  cliVersion,
  docker: 'available',
  sessionStartedMs: 1_000,
});

const ctxReporting = (version: string | null) => ({
  exec: async (): Promise<CommandResult> => ({
    ok: version !== null,
    exitCode: version === null ? 1 : 0,
    stdout: version === null ? '' : `${version}\n`,
    stderr: '',
  }),
});

describe('readStagedCliVersion', () => {
  it('prefers the marker version over the post-run supabase --version', async () => {
    expect(
      await readStagedCliVersion(ctxReporting('2.120.0'), marker('2.119.0'))
    ).toBe('2.119.0');
  });

  it('falls back to supabase --version without a marker version', async () => {
    expect(await readStagedCliVersion(ctxReporting('2.120.0'), undefined)).toBe(
      '2.120.0'
    );
    expect(
      await readStagedCliVersion(ctxReporting('2.120.0'), marker(''))
    ).toBe('2.120.0');
  });

  it('keeps a global reinstall of another version an override', async () => {
    const staged = await readStagedCliVersion(
      ctxReporting('2.120.0'),
      marker('2.119.0')
    );
    const invocations = findSupabaseInvocations([
      { command: 'npm i -g supabase@2.120.0' },
      'supabase start',
    ]);
    expect(listCliOverrides(invocations, staged)).toEqual([
      'npm i -g supabase@2.120.0',
    ]);
    expect(listCliOverrides(invocations, '2.120.0')).toEqual([]);
  });
});

describe('readCliVersions', () => {
  it('reports the staged version and the differing post-run version', async () => {
    expect(
      await readCliVersions(ctxReporting('2.120.0'), marker('2.119.0'))
    ).toEqual({ cliVersion: '2.119.0', cliVersionAfterRun: '2.120.0' });
  });

  it('omits the post-run version when it matches or cannot be read', async () => {
    expect(
      await readCliVersions(ctxReporting('v2.119.0'), marker('2.119.0'))
    ).toEqual({ cliVersion: '2.119.0' });
    expect(
      await readCliVersions(ctxReporting(null), marker('2.119.0'))
    ).toEqual({
      cliVersion: '2.119.0',
    });
  });

  it('reports only the live version without a marker', async () => {
    expect(await readCliVersions(ctxReporting('2.120.0'), undefined)).toEqual({
      cliVersion: '2.120.0',
    });
  });
});
