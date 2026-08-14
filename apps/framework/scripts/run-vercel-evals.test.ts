import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APIError } from '@vercel/sandbox';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  aggregateAttempts,
  parsePairs,
  runBounded,
  type EvalPair,
} from './run-vercel-evals.js';
import { isRetryableSandboxCreateError, tagValue } from './vercel-sandbox.js';

describe('Vercel eval controller', () => {
  it('bounds concurrent work and lets independent failures settle', async () => {
    let active = 0;
    let maximum = 0;
    const results = await runBounded([1, 2, 3, 4], 2, async (item) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      if (item === 2) throw new Error('terminal');
      return item;
    });

    expect(maximum).toBe(2);
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
    ]);
  });

  it('sanitizes Sandbox names and tags to the allowed charset', () => {
    expect(tagValue('openai-gpt-5.4-nano')).toBe('openai-gpt-5-4-nano');
    expect(tagValue('Build CLI / Bootstrap App!')).toBe(
      'build-cli-bootstrap-app-'
    );
    expect(tagValue('a'.repeat(100))).toHaveLength(64);
  });

  it('validates pair input before starting Sandboxes', () => {
    expect(
      parsePairs(
        JSON.stringify([
          {
            eval_id: 'eval-1',
            experiment: 'experiment-1',
            experiment_suite: 'benchmark',
            eval_suite: 'benchmark',
          },
        ])
      )
    ).toHaveLength(1);
    expect(() => parsePairs('[{"eval_id":"eval-1"}]')).toThrow(
      'each pair must contain'
    );
  });

  it('retries sandbox creation only on network errors, 429s, and 5xx', () => {
    const apiError = (status: number) =>
      new APIError(new Response(null, { status }));
    expect(isRetryableSandboxCreateError(apiError(429))).toBe(true);
    expect(isRetryableSandboxCreateError(apiError(500))).toBe(true);
    expect(isRetryableSandboxCreateError(apiError(401))).toBe(false);
    expect(isRetryableSandboxCreateError(apiError(400))).toBe(false);
    expect(isRetryableSandboxCreateError(new TypeError('fetch failed'))).toBe(
      true
    );
  });
});

describe('aggregateAttempts (any-pass)', () => {
  const pair: EvalPair = {
    eval_id: 'e1',
    experiment: 'exp1',
    experiment_suite: 'benchmark',
    eval_suite: 'benchmark',
  };
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agg-test-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const attemptDir = (
    name: string,
    result: { passed: boolean; marker: string } | null
  ): string => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    if (result) {
      writeFileSync(
        join(dir, `${pair.eval_id}.json`),
        JSON.stringify({ ...result, attempts: 1, checks: [] })
      );
    }
    return dir;
  };
  const output = () =>
    JSON.parse(
      readFileSync(
        join(root, 'out', `raw-results-${pair.experiment}__${pair.eval_id}`, `${pair.eval_id}.json`),
        'utf8'
      )
    ) as { passed: boolean; attempts: number; marker: string };

  it('passes if any attempt passed and keeps the passing tree', () => {
    aggregateAttempts(
      pair,
      [
        attemptDir('a1', { passed: false, marker: 'fail' }),
        attemptDir('a2', { passed: true, marker: 'pass' }),
      ],
      join(root, 'out')
    );
    expect(output()).toMatchObject({ passed: true, attempts: 2, marker: 'pass' });
  });

  it('fails only when every attempt failed', () => {
    aggregateAttempts(
      pair,
      [
        attemptDir('a1', { passed: false, marker: 'a1' }),
        attemptDir('a2', { passed: false, marker: 'a2' }),
      ],
      join(root, 'out')
    );
    expect(output()).toMatchObject({ passed: false, attempts: 2 });
  });

  it('counts only attempts that produced a result file', () => {
    aggregateAttempts(
      pair,
      [
        attemptDir('a1', { passed: true, marker: 'pass' }),
        attemptDir('a2', null),
      ],
      join(root, 'out')
    );
    expect(output()).toMatchObject({ passed: true, attempts: 1, marker: 'pass' });
  });

  it('throws when no attempt produced a result file', () => {
    expect(() =>
      aggregateAttempts(pair, [attemptDir('a1', null)], join(root, 'out'))
    ).toThrow('no attempt produced a result');
  });
});
