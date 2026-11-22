// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/benchmark/build-cli-002-declarative-schema
import type {
  CommandResult,
  LocalStackEvalContext,
  ToolCallRecord,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import scorer from './EVAL.js';

const CHECK_NAME =
  'migration generated with supabase db schema declarative sync or db diff';

function call(command: string): ToolCallRecord {
  return {
    tool: { kind: 'other', toolName: 'shell' },
    body: { command },
    command,
    result: '',
    ts: 0,
  };
}

function result(stdout: string): CommandResult {
  return { ok: true, exitCode: 0, stdout, stderr: '' };
}

/** A finished run: the schema file has the column, a second migration exists, and the column is live. */
function context(commands: string[]): LocalStackEvalContext {
  return {
    toolCalls: commands.map(call),
    exec: async (command: string) =>
      command.startsWith('cat supabase/schemas')
        ? result(
            'create table products (id bigint primary key, description text);\n'
          )
        : result('2\n'),
    query: async () => ({ rows: [{ column_name: 'description' }] }),
  } as unknown as LocalStackEvalContext;
}

async function generatorCheck(commands: string[]) {
  const { passed, checks } = await scorer(context(commands));
  const check = checks?.find((c) => c.name === CHECK_NAME);
  return { passed, checkPassed: check?.passed };
}

describe('build-cli-002 scorer', () => {
  it.each([
    'supabase db diff -f add_products_description',
    'supabase db schema declarative sync -f add_products_description --no-apply --experimental',
    'cd supabase/schemas && cd ../.. && supabase db schema declarative sync --experimental -f add_description',
  ])('passes when the migration was generated with %s', async (command) => {
    expect(await generatorCheck([command])).toEqual({
      passed: true,
      checkPassed: true,
    });
  });

  it('fails when the migration was written by hand', async () => {
    expect(
      await generatorCheck([
        'supabase migration new add_products_description',
        'supabase migration up',
      ])
    ).toEqual({ passed: false, checkPassed: false });
  });

  it('does not count other db schema commands', async () => {
    expect(
      await generatorCheck(['supabase db schema declarative generate'])
    ).toEqual({ passed: false, checkPassed: false });
  });
});
