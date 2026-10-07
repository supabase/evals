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
  stackIdNames,
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
  it('runs under a relocated CLI home when given one', async () => {
    const { ctx, commands } = fakeCtx(commandResult('{"stacks":[]}'));
    await readStackList(ctx, { SUPABASE_HOME: '/s/.home', TMPDIR: '/s/.tmp' });
    expect(commands).toEqual([
      "SUPABASE_HOME='/s/.home' TMPDIR='/s/.tmp' SUPABASE_EXPERIMENTAL_STACK=1 supabase stack list --output-format json",
    ]);
  });

  it('parses the empty envelope with an explicit json output format', async () => {
    const { ctx, commands } = fakeCtx(
      commandResult('{"stacks":[],"message":""}')
    );
    expect(await readStackList(ctx)).toEqual({ ok: true, stacks: [] });
    expect(commands).toEqual([
      'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack list --output-format json',
    ]);
  });

  it('keeps entries whatever their shape and drops nulls', async () => {
    const { ctx } = fakeCtx(
      commandResult(
        '{"stacks":[{"id":"abc","stack":{"label":"checkout-service"}},"stray",null],"message":""}'
      )
    );
    expect(await readStackList(ctx)).toEqual({
      ok: true,
      stacks: [{ id: 'abc', stack: { label: 'checkout-service' } }, 'stray'],
    });
  });

  it('accepts a top-level array as the stacks list', async () => {
    const { ctx } = fakeCtx(
      commandResult('[{"name":"legacy-import","status":"stopped"}]')
    );
    const result = await readStackList(ctx);
    expect(result).toEqual({
      ok: true,
      stacks: [{ name: 'legacy-import', status: 'stopped' }],
    });
    expect(stackListContainsName(result, 'legacy-import')).toBe(true);
  });

  it('accepts a top-level array after [task] progress lines', async () => {
    const { ctx } = fakeCtx(
      commandResult('[task] listing\n[\n  {"name":"payments-api"}\n]\n')
    );
    expect(await readStackList(ctx)).toEqual({
      ok: true,
      stacks: [{ name: 'payments-api' }],
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

  it('is unsupported when there is no stack command at all', async () => {
    const { ctx } = fakeCtx({
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr: 'Error: unknown command "stack" for "supabase"',
    });
    expect(await readStackList(ctx)).toEqual({
      ok: false,
      unsupported: true,
      notes: 'exit 1: Error: unknown command "stack" for "supabase"',
    });
  });

  it.each([
    ['Unknown subcommand stack'],
    ['{"_tag":"Error","error":{"code":"UnknownSubcommand"}}'],
  ])('is unsupported on %s', async (stdout) => {
    const { ctx } = fakeCtx(commandResult(stdout, false));
    const result = await readStackList(ctx);
    expect(!result.ok && result.unsupported).toBe(true);
  });

  it.each([
    ['an object with no stacks array', '{"message":"ok"}', true],
    ['garbage', 'legacy-import  stopped', true],
    ['empty output', '', true],
    [
      'an unrelated CLI error envelope',
      '{"_tag":"Error","message":"No managed stack exists"}',
      false,
    ],
  ])('fails closed on %s', async (_label, stdout, ok) => {
    const { ctx } = fakeCtx(commandResult(stdout, ok));
    const result = await readStackList(ctx);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.unsupported).toBe(false);
    expect(!result.ok && result.notes).toContain(
      'unreadable stack list output'
    );
  });

  it('fails closed with the thrown message when exec throws', async () => {
    const { ctx } = fakeCtx(new Error('sandbox gone'));
    expect(await readStackList(ctx)).toEqual({
      ok: false,
      unsupported: false,
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
      stackListContainsName(
        { ok: false, unsupported: true, notes: 'x' },
        'legacy-import'
      )
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

describe('stackIdNames', () => {
  const NAMES = ['checkout-service', 'payments-api', 'legacy-import'];

  it('maps ids by name or project_root basename', () => {
    const output = JSON.stringify({
      stacks: [
        { id: 'aa', name: 'payments-api' },
        { id: 'bb', name: 'default', project_root: '/work/legacy-import' },
        { id: 'cc', name: 'other', project_root: '/work/other' },
        { name: 'checkout-service' },
      ],
    });
    expect([...stackIdNames(output, NAMES)]).toEqual([
      ['aa', 'payments-api'],
      ['bb', 'legacy-import'],
    ]);
  });

  it('is empty for output that is not a stack list', () => {
    expect(stackIdNames('no stacks here', NAMES).size).toBe(0);
  });
});
