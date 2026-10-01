// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/build-database-002-stack-lifecycle
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  checkMetrics,
  parseJsonObject,
  readDbUrl,
  readRuntimeKind,
} from './stack.js';

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

describe('parseJsonObject', () => {
  it('parses plain JSON', () => {
    expect(parseJsonObject('{"DB_URL":"postgresql://x"}')).toEqual({
      DB_URL: 'postgresql://x',
    });
  });

  it('extracts JSON wrapped in `[task] …` progress lines', () => {
    const stdout = [
      '[task] resolving stack status',
      '{"DB_URL":"postgresql://x"}',
      '[task] done',
    ].join('\n');
    expect(parseJsonObject(stdout)).toEqual({ DB_URL: 'postgresql://x' });
  });

  it('returns undefined when stdout has no JSON object', () => {
    expect(parseJsonObject('[task] no stack running')).toBeUndefined();
  });

  it('extracts JSON preceded by a `[task]` line with a brace-looking word', () => {
    expect(parseJsonObject('[task] starting {stack}\n{"DB_URL":"x"}')).toEqual({
      DB_URL: 'x',
    });
  });

  it('extracts JSON followed by a `[task]` line with a brace-looking word', () => {
    expect(parseJsonObject('{"DB_URL":"x"}\n[task] done {ok}')).toEqual({
      DB_URL: 'x',
    });
  });

  it('returns the first object when stdout has more than one', () => {
    expect(parseJsonObject('{"a":1}\n{"DB_URL":"x"}')).toEqual({ a: 1 });
  });

  it('parses a stderr-style error payload', () => {
    expect(parseJsonObject('{"_tag":"Errors","errors":[]}')).toEqual({
      _tag: 'Errors',
      errors: [],
    });
  });
});

describe('readDbUrl', () => {
  it.each<[stdout: string, expected: string | undefined]>([
    ['{"_tag":"Help","doc":{}}', undefined],
    ['[task] resolving\n{"DB_URL":"postgresql://x"}', 'postgresql://x'],
    ['', undefined],
  ])('reads DB_URL from %j as %j', (stdout, expected) => {
    expect(readDbUrl(stdout)).toBe(expected);
  });
});

describe('readRuntimeKind', () => {
  it.each<[stdout: string, expected: 'native' | 'docker' | 'unknown']>([
    ['{"runtime":{"kind":"native"}}', 'native'],
    ['{"DB_URL":"x"}', 'unknown'],
  ])('reads runtime.kind from %j as %j', (stdout, expected) => {
    expect(readRuntimeKind(stdout)).toBe(expected);
  });
});

describe('checkMetrics', () => {
  const fakeMetricsCtx = {
    exec: async () => commandResult('', false),
  } as unknown as LocalStackEvalContext;

  it('reports channel "pinned" when the environment marker is missing', async () => {
    const result = await checkMetrics(fakeMetricsCtx, undefined, [], [], {
      ok: false,
      notes: 'no stack',
    });
    expect(result.passed).toBe(true);
    expect(JSON.parse(result.notes as string).channel).toBe('pinned');
  });

  it('reports the marker channel when present', async () => {
    const result = await checkMetrics(
      fakeMetricsCtx,
      {
        runtime: 'local-stack',
        channel: 'beta',
        cliVersion: '2.0.0',
        docker: 'available',
        sessionStartedMs: 0,
      },
      [],
      [],
      { ok: false, notes: 'no stack' }
    );
    expect(JSON.parse(result.notes as string).channel).toBe('beta');
  });
});
