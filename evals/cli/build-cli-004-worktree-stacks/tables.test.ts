// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/build-cli-004-worktree-stacks
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import type { StackProbe } from '../lib/stack.js';
import type { WorktreeStacks } from './stacks.js';
import { checkSchemaIsolation, checkSeeded } from './tables.js';

const PORTS = { 'feature-a': 1, 'feature-b': 2, 'feature-c': 3 } as const;

function stack(port: number): StackProbe {
  return {
    ok: true,
    backend: 'managed',
    dbUrl: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
    runtime: 'native',
  };
}

const STACKS: WorktreeStacks = {
  'feature-a': stack(1),
  'feature-b': stack(2),
  'feature-c': stack(3),
};

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

/** `tables` maps a port to the tables in that stack and their row counts. */
function fakeCtx(
  tables: Record<number, Record<string, number>>
): Pick<LocalStackEvalContext, 'exec'> {
  return {
    exec: async (command: string) => {
      const port = Number(command.match(/@127\.0\.0\.1:(\d+)\//)?.[1]);
      const rows = tables[port];
      if (!rows) return commandResult('', false);
      const exists = command.match(/to_regclass\('public\.(\w+)'\)/);
      if (exists) return commandResult(exists[1] in rows ? 't' : 'f');
      const count = command.match(/count\(\*\) from public\.(\w+)/);
      if (count) {
        return count[1] in rows
          ? commandResult(String(rows[count[1]]))
          : commandResult('', false);
      }
      return commandResult('', false);
    },
  };
}

const ONE_TABLE_EACH = {
  [PORTS['feature-a']]: { widgets: 1 },
  [PORTS['feature-b']]: { gadgets: 1 },
  [PORTS['feature-c']]: { gizmos: 1 },
};

describe('checkSchemaIsolation', () => {
  const widgets = { worktree: 'feature-a', table: 'widgets' } as const;

  it('passes when the table is only in its home stack', async () => {
    const result = await checkSchemaIsolation(
      fakeCtx(ONE_TABLE_EACH),
      STACKS,
      widgets
    );
    expect(result).toEqual({
      name: "widgets exists only in feature-a's stack",
      passed: true,
      notes: 'feature-a: present, feature-b: absent, feature-c: absent',
    });
  });

  it('fails when the table leaked into another stack', async () => {
    const result = await checkSchemaIsolation(
      fakeCtx({ ...ONE_TABLE_EACH, [2]: { gadgets: 1, widgets: 0 } }),
      STACKS,
      widgets
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('feature-b: present');
  });

  it('fails when the table is missing from its home stack', async () => {
    const result = await checkSchemaIsolation(
      fakeCtx({ ...ONE_TABLE_EACH, [1]: {} }),
      STACKS,
      widgets
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('feature-a: absent');
  });

  it('fails when a stack did not resolve', async () => {
    const result = await checkSchemaIsolation(
      fakeCtx(ONE_TABLE_EACH),
      { ...STACKS, 'feature-c': { ok: false, notes: 'down' } },
      widgets
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('feature-c: no stack');
  });

  it('fails with the query error when psql cannot reach a stack', async () => {
    const result = await checkSchemaIsolation(fakeCtx({}), STACKS, widgets);
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('exit 1');
  });
});

describe('checkSeeded', () => {
  const gadgets = { worktree: 'feature-b', table: 'gadgets' } as const;

  it('passes with at least one row in the home stack', async () => {
    const result = await checkSeeded(fakeCtx(ONE_TABLE_EACH), STACKS, gadgets);
    expect(result).toEqual({
      name: "gadgets has at least 1 row in feature-b's stack",
      passed: true,
      notes: 'found 1 rows',
    });
  });

  it('fails when the table is empty', async () => {
    const result = await checkSeeded(
      fakeCtx({ ...ONE_TABLE_EACH, [2]: { gadgets: 0 } }),
      STACKS,
      gadgets
    );
    expect(result.passed).toBe(false);
  });

  it('fails when the table does not exist', async () => {
    const result = await checkSeeded(
      fakeCtx({ ...ONE_TABLE_EACH, [2]: {} }),
      STACKS,
      gadgets
    );
    expect(result.passed).toBe(false);
  });

  it('fails when the stack did not resolve', async () => {
    const result = await checkSeeded(
      fakeCtx(ONE_TABLE_EACH),
      { ...STACKS, 'feature-b': { ok: false, notes: 'down' } },
      gadgets
    );
    expect(result).toMatchObject({
      passed: false,
      notes: 'feature-b: no stack',
    });
  });
});
