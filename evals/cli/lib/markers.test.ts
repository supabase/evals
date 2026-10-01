// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/lib
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  checkMarkerIsolation,
  readRowStrings,
  type RowStringsProbe,
} from './markers.js';
import type { ResolvedStack } from './stack.js';

const STACK: ResolvedStack = {
  ok: true,
  backend: 'managed',
  dbUrl: 'postgresql://x',
  runtime: 'native',
};

function fakeCtx(result: CommandResult | Error) {
  const commands: string[] = [];
  const ctx = {
    exec: async (command: string) => {
      commands.push(command);
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as Pick<LocalStackEvalContext, 'exec'>;
  return { ctx, commands };
}

const rows = (...values: string[]): RowStringsProbe => ({ ok: true, values });

describe('readRowStrings', () => {
  it('collects every string value from every row', async () => {
    const { ctx, commands } = fakeCtx({
      ok: true,
      exitCode: 0,
      stdout:
        '[{"id":1,"name":"client-a"},{"id":2,"label":"extra","n":null}]\n',
      stderr: '',
    });
    expect(await readRowStrings(ctx, STACK, 'public.clients')).toEqual({
      ok: true,
      values: ['client-a', 'extra'],
    });
    expect(commands).toEqual([
      `psql 'postgresql://x' -tAc "select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.clients t"`,
    ]);
  });

  it('surfaces a psql failure', async () => {
    const { ctx } = fakeCtx({
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr: 'ERROR:  relation "public.clients" does not exist',
    });
    expect(await readRowStrings(ctx, STACK, 'public.clients')).toEqual({
      ok: false,
      notes: 'exit 1: ERROR:  relation "public.clients" does not exist',
    });
  });

  it('reports unparseable output', async () => {
    const { ctx } = fakeCtx({
      ok: true,
      exitCode: 0,
      stdout: 'garbage',
      stderr: '',
    });
    expect(await readRowStrings(ctx, STACK, 'public.clients')).toEqual({
      ok: false,
      notes: 'could not parse public.clients rows: garbage',
    });
  });

  it('reports an exec throw', async () => {
    const { ctx } = fakeCtx(new Error('sandbox gone'));
    expect(await readRowStrings(ctx, STACK, 'public.clients')).toEqual({
      ok: false,
      notes: 'sandbox gone',
    });
  });
});

describe('checkMarkerIsolation', () => {
  const NAME = 'each project holds only its own marker row';

  it('passes when each db holds only its own label', () => {
    expect(
      checkMarkerIsolation(NAME, [
        { label: 'client-a', rows: rows('client-a') },
        { label: 'client-b', rows: rows('client-b', 'other') },
      ])
    ).toEqual({
      name: NAME,
      passed: true,
      notes:
        'client-a db rows: ["client-a"]; client-b db rows: ["client-b","other"]',
    });
  });

  it('fails when the rows are swapped', () => {
    expect(
      checkMarkerIsolation(NAME, [
        { label: 'client-a', rows: rows('client-b') },
        { label: 'client-b', rows: rows('client-a') },
      ]).passed
    ).toBe(false);
  });

  it('fails when one db holds both labels', () => {
    expect(
      checkMarkerIsolation(NAME, [
        { label: 'client-a', rows: rows('client-a', 'client-b') },
        { label: 'client-b', rows: rows('client-b') },
      ]).passed
    ).toBe(false);
  });

  it('matches labels case-insensitively', () => {
    expect(
      checkMarkerIsolation(NAME, [
        { label: 'client-a', rows: rows('Client-A') },
        { label: 'client-b', rows: rows('CLIENT-B marker') },
      ]).passed
    ).toBe(true);
  });

  it('fails with each entry described when any rows are unreadable', () => {
    expect(
      checkMarkerIsolation(NAME, [
        { label: 'client-a', rows: rows('client-a') },
        { label: 'client-b', rows: { ok: false, notes: 'relation missing' } },
      ])
    ).toEqual({
      name: NAME,
      passed: false,
      notes:
        'client-a db rows: ["client-a"]; client-b db rows: relation missing',
    });
  });
});
