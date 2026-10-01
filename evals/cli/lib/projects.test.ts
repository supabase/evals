// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/lib
import type { LocalStackEvalContext } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findProjectDirs } from './projects.js';

function fakeCtx(configPaths: string[] | Error) {
  const commands: string[] = [];
  const ctx = {
    exec: async (command: string) => {
      commands.push(command);
      if (configPaths instanceof Error) throw configPaths;
      return {
        ok: true,
        exitCode: 0,
        stdout: configPaths.map((path) => `${path}\n`).join(''),
        stderr: '',
      };
    },
  } as unknown as Pick<LocalStackEvalContext, 'exec'>;
  return { ctx, commands };
}

describe('findProjectDirs', () => {
  it('discovers config.toml up to depth 4 by default', async () => {
    const { ctx, commands } = fakeCtx([]);
    await findProjectDirs(ctx, ['client-a']);
    expect(commands).toEqual([
      "find . -maxdepth 4 -path '*/supabase/config.toml' -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null",
    ]);
  });

  it('honours maxDepth', async () => {
    const { ctx, commands } = fakeCtx([]);
    await findProjectDirs(ctx, ['client-a'], { maxDepth: 2 });
    expect(commands[0]).toContain('-maxdepth 2 ');
  });

  it('resolves nested and root-level projects by basename', async () => {
    const { ctx } = fakeCtx([
      './projects/client-a/supabase/config.toml',
      './client-b/supabase/config.toml',
    ]);
    expect(await findProjectDirs(ctx, ['client-a', 'client-b'])).toEqual({
      found: { 'client-a': './projects/client-a', 'client-b': './client-b' },
      problems: {},
      all: ['./projects/client-a', './client-b'],
    });
  });

  it('prefers the exact basename over a longer name containing it', async () => {
    const { ctx } = fakeCtx([
      './client-a-old/supabase/config.toml',
      './client-a/supabase/config.toml',
    ]);
    const { found, problems } = await findProjectDirs(ctx, ['client-a']);
    expect(found).toEqual({ 'client-a': './client-a' });
    expect(problems).toEqual({});
  });

  it('falls back to a unique substring match', async () => {
    const { ctx } = fakeCtx(['./my-client-a-app/supabase/config.toml']);
    const { found } = await findProjectDirs(ctx, ['client-a']);
    expect(found).toEqual({ 'client-a': './my-client-a-app' });
  });

  it('reports an ambiguous substring match instead of guessing', async () => {
    const { ctx } = fakeCtx([
      './client-a-old/supabase/config.toml',
      './client-a-new/supabase/config.toml',
    ]);
    expect(await findProjectDirs(ctx, ['client-a'])).toMatchObject({
      found: {},
      problems: { 'client-a': 'ambiguous (./client-a-old, ./client-a-new)' },
    });
  });

  it('reports duplicate exact matches as ambiguous', async () => {
    const { ctx } = fakeCtx([
      './client-a/supabase/config.toml',
      './backup/client-a/supabase/config.toml',
    ]);
    const { problems } = await findProjectDirs(ctx, ['client-a']);
    expect(problems).toEqual({
      'client-a': 'ambiguous (./client-a, ./backup/client-a)',
    });
  });

  it('resolves the other names when one is missing', async () => {
    const { ctx } = fakeCtx([
      './checkout-service/supabase/config.toml',
      './payments-api/supabase/config.toml',
    ]);
    expect(
      await findProjectDirs(ctx, [
        'checkout-service',
        'payments-api',
        'legacy-import',
      ])
    ).toMatchObject({
      found: {
        'checkout-service': './checkout-service',
        'payments-api': './payments-api',
      },
      problems: { 'legacy-import': 'no matching project directory' },
    });
  });

  it('records an exec failure against every name', async () => {
    const { ctx } = fakeCtx(new Error('sandbox gone'));
    expect(await findProjectDirs(ctx, ['a', 'b'])).toEqual({
      found: {},
      problems: { a: 'sandbox gone', b: 'sandbox gone' },
      all: [],
    });
  });
});
