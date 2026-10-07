// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/build-database-003-parallel-projects
import type { LocalStackEvalContext } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findProjectDirs } from '../lib/projects.js';
import { CLIENTS, checkProjectsInitialised } from './projects.js';

function fakeFindCtx(
  configPaths: string[]
): Pick<LocalStackEvalContext, 'exec'> {
  return {
    exec: async () => ({
      ok: true,
      exitCode: 0,
      stdout: configPaths.map((path) => `${path}\n`).join(''),
      stderr: '',
    }),
  };
}

async function initialised(configPaths: string[]) {
  const dirs = await findProjectDirs(fakeFindCtx(configPaths), CLIENTS);
  return checkProjectsInitialised(dirs);
}

describe('checkProjectsInitialised', () => {
  it('passes when both projects sit at the workspace root', async () => {
    const result = await initialised([
      './client-a/supabase/config.toml',
      './client-b/supabase/config.toml',
    ]);
    expect(result.passed).toBe(true);
    expect(result.notes).toBe('client-a: ./client-a; client-b: ./client-b');
  });

  it('passes when the projects are nested one level down', async () => {
    const result = await initialised([
      './projects/client-a/supabase/config.toml',
      './projects/client-b/supabase/config.toml',
    ]);
    expect(result.passed).toBe(true);
  });

  it('resolves client-a by exact basename when client-a-old also exists', async () => {
    const result = await initialised([
      './client-a-old/supabase/config.toml',
      './client-a/supabase/config.toml',
      './client-b/supabase/config.toml',
    ]);
    expect(result.passed).toBe(true);
    expect(result.notes).toBe('client-a: ./client-a; client-b: ./client-b');
  });

  it('fails and lists what was found when one project is missing', async () => {
    const result = await initialised(['./client-a/supabase/config.toml']);
    expect(result.passed).toBe(false);
    expect(result.notes).toBe(
      'client-a: ./client-a; client-b: no matching project directory; supabase/config.toml found under: ./client-a'
    );
  });

  it('fails when no project exists', async () => {
    const result = await initialised([]);
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('found under: none');
  });

  it('fails when both names resolve to the same directory', async () => {
    const result = await initialised([
      './client-a-and-client-b/supabase/config.toml',
    ]);
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('both resolved to the same directory');
  });
});
