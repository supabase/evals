// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/lib
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  collectStringValues,
  readStackList,
  stackEntryMatchesName,
  stackListContainsName,
} from './stack-list.js';

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

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

describe('readStackList', () => {
  it('parses the empty envelope with an explicit json output format', async () => {
    const { ctx, commands } = fakeCtx(
      commandResult('{"stacks":[],"message":""}')
    );
    expect(await readStackList(ctx)).toEqual({ ok: true, stacks: [] });
    expect(commands).toEqual([
      'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack list --output-format json',
    ]);
  });

  it('keeps object entries whatever their shape and drops non-objects', async () => {
    const { ctx } = fakeCtx(
      commandResult(
        '{"stacks":[{"id":"abc","stack":{"label":"checkout-service"}},"stray",null],"message":""}'
      )
    );
    expect(await readStackList(ctx)).toEqual({
      ok: true,
      stacks: [{ id: 'abc', stack: { label: 'checkout-service' } }],
    });
  });

  it('extracts the envelope from around [task] progress lines', async () => {
    const { ctx } = fakeCtx(
      commandResult('[task] listing\n{"stacks":[{"name":"payments-api"}]}\n')
    );
    expect(await readStackList(ctx)).toEqual({
      ok: true,
      stacks: [{ name: 'payments-api' }],
    });
  });

  it('fails with the CLI error when there is no stack command at all', async () => {
    const { ctx } = fakeCtx({
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr: 'Error: unknown command "stack" for "supabase"',
    });
    const result = await readStackList(ctx);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.notes).toContain('unknown command');
  });

  it('fails when the JSON has no stacks array', async () => {
    const { ctx } = fakeCtx(
      commandResult(
        '{"_tag":"Error","error":{"code":"UnknownSubcommand"}}',
        false
      )
    );
    const result = await readStackList(ctx);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.notes).toContain('no "stacks" array');
  });

  it('fails with the thrown message when exec throws', async () => {
    const { ctx } = fakeCtx(new Error('sandbox gone'));
    expect(await readStackList(ctx)).toEqual({
      ok: false,
      notes: 'sandbox gone',
    });
  });
});

describe('collectStringValues', () => {
  it('collects every string found anywhere inside a value', () => {
    expect(
      collectStringValues({ a: 'x', b: { c: 'y', d: ['z', 1, null] } })
    ).toEqual(['x', 'y', 'z']);
  });
});

describe('stackEntryMatchesName', () => {
  it.each([
    ['top level', { name: 'legacy-import' }],
    ['nested one level', { stack: { label: 'legacy-import' } }],
    ['inside an array field', { tags: ['service:legacy-import'] }],
    [
      'inside an array of objects',
      { metadata: { services: [{ id: 1, name: 'legacy-import' }] } },
    ],
  ])('matches a name %s', (_label, entry) => {
    expect(stackEntryMatchesName(entry, 'legacy-import')).toBe(true);
  });

  it('does not match an unrelated entry', () => {
    expect(
      stackEntryMatchesName({ name: 'checkout-service' }, 'legacy-import')
    ).toBe(false);
  });
});

describe('stackListContainsName', () => {
  it('is false when the listing is unavailable', () => {
    expect(
      stackListContainsName({ ok: false, notes: 'x' }, 'legacy-import')
    ).toBe(false);
  });

  it('is true when any entry matches', () => {
    expect(
      stackListContainsName(
        { ok: true, stacks: [{ name: 'a' }, { name: 'legacy-import' }] },
        'legacy-import'
      )
    ).toBe(true);
  });
});
