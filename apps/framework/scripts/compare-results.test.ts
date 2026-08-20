import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  armCliVersions,
  compareArms,
  loadArm,
  renderMarkdown,
  type Arm,
  type ArmResult,
} from './compare-results.js';

function result(overrides: Partial<ArmResult> & { eval: string }): ArmResult {
  return {
    passed: false,
    checksPassed: 0,
    checksTotal: 0,
    ...overrides,
  };
}

function arm(name: string, results: ArmResult[]): Arm {
  return { name, results };
}

describe('compareArms', () => {
  it('classifies pass/fail transitions per eval', () => {
    const baseline = arm('pin', [
      result({ eval: 'a', passed: false }),
      result({ eval: 'b', passed: true }),
      result({ eval: 'c', passed: true }),
      result({ eval: 'd', passed: false }),
    ]);
    const candidate = arm('beta', [
      result({ eval: 'a', passed: true }),
      result({ eval: 'b', passed: false }),
      result({ eval: 'c', passed: true }),
      result({ eval: 'd', passed: false }),
    ]);

    expect(
      compareArms(baseline, candidate).map((d) => [d.eval, d.verdict])
    ).toEqual([
      ['a', 'improved'],
      ['b', 'regressed'],
      ['c', 'unchanged'],
      ['d', 'unchanged'],
    ]);
  });

  it('reports evals present in only one arm without comparing them', () => {
    const baseline = arm('pin', [
      result({ eval: 'both' }),
      result({ eval: 'pin-only', passed: true }),
    ]);
    const candidate = arm('beta', [
      result({ eval: 'both' }),
      result({ eval: 'beta-only' }),
    ]);

    const byEval = new Map(
      compareArms(baseline, candidate).map((d) => [d.eval, d.verdict])
    );
    expect(byEval.get('pin-only')).toBe('baseline-only');
    expect(byEval.get('beta-only')).toBe('candidate-only');
    expect(byEval.get('both')).toBe('unchanged');
  });
});

describe('armCliVersions', () => {
  it('reports the unique resolved versions, not the requested pin', () => {
    const versions = armCliVersions(
      arm('pin', [
        result({ eval: 'a', resolvedCliVersion: '2.67.1' }),
        result({ eval: 'b', resolvedCliVersion: '2.67.1' }),
        result({ eval: 'c' }),
      ])
    );
    expect(versions).toBe('2.67.1');
  });

  it('falls back to a placeholder when no result carries a version', () => {
    expect(armCliVersions(arm('pin', [result({ eval: 'a' })]))).toBe(
      'unknown CLI version'
    );
  });
});

describe('renderMarkdown', () => {
  const baseline = arm('claude-code-sonnet-5', [
    result({
      eval: 'build-docs-001',
      passed: true,
      checksPassed: 6,
      checksTotal: 6,
      resolvedCliVersion: '2.67.1',
    }),
  ]);

  it('flags regressions with a file-an-issue bottom line', () => {
    const candidate = arm('claude-code-sonnet-5-cli-beta', [
      result({
        eval: 'build-docs-001',
        passed: false,
        checksPassed: 3,
        checksTotal: 6,
        resolvedCliVersion: '2.115.1-beta.6',
      }),
    ]);
    const markdown = renderMarkdown(
      baseline,
      candidate,
      compareArms(baseline, candidate)
    );

    expect(markdown).toContain('CLI version delta: 2.67.1 → 2.115.1-beta.6');
    expect(markdown).toContain(
      '| build-docs-001 | ✅ pass | ❌ fail | 6/6 → 3/6 | 🔴 REGRESSED (PASS→FAIL) |'
    );
    expect(markdown).toContain('0 improved, 1 regressed, 0 unchanged');
    expect(markdown).toContain('REGRESSED 1 scenario(s)');
    expect(markdown).toContain('file a supabase/cli issue');
  });

  it('collapses one-sided evals into a footnote instead of table rows', () => {
    const wideBaseline = arm('claude-code-sonnet-5', [
      ...baseline.results,
      result({ eval: 'investigate-security-010', passed: true }),
    ]);
    const candidate = arm('claude-code-sonnet-5-cli-beta', [
      result({
        eval: 'build-docs-001',
        passed: true,
        checksPassed: 6,
        checksTotal: 6,
      }),
    ]);
    const markdown = renderMarkdown(
      wideBaseline,
      candidate,
      compareArms(wideBaseline, candidate)
    );

    expect(markdown).not.toContain('| investigate-security-010 |');
    expect(markdown).toContain(
      'Baseline only (skipped or missing in candidate): `investigate-security-010`'
    );
    expect(markdown).toContain('0 improved, 0 regressed, 1 unchanged');
  });

  it('reports no pass/fail change when only checks moved', () => {
    const candidate = arm('claude-code-sonnet-5-cli-beta', [
      result({
        eval: 'build-docs-001',
        passed: true,
        checksPassed: 5,
        checksTotal: 6,
        resolvedCliVersion: '2.115.1-beta.6',
      }),
    ]);
    const markdown = renderMarkdown(
      baseline,
      candidate,
      compareArms(baseline, candidate)
    );

    expect(markdown).toContain('6/6 → 5/6');
    expect(markdown).toContain(
      '→ no pass/fail change (compare the checks column above).'
    );
  });
});

describe('loadArm', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads top-level result files and skips workspaces and bad snapshots', () => {
    dir = mkdtempSync(join(tmpdir(), 'compare-results-'));
    writeFileSync(
      join(dir, 'build-docs-001.json'),
      JSON.stringify({
        experiment: 'claude-code-sonnet-5-cli-beta',
        eval: 'build-docs-001',
        passed: true,
        checks: [
          { name: 'one', passed: true },
          { name: 'two', passed: false },
        ],
        resolvedCliVersion: '2.115.1-beta.6',
      })
    );
    // Attempt workspaces live in subdirectories next to the result files.
    mkdirSync(join(dir, 'build-docs-001', 'attempt-1'), { recursive: true });
    // A snapshot whose enum drifted from the current schema fails to parse.
    writeFileSync(
      join(dir, 'stale.json'),
      JSON.stringify({ experiment: 'x', eval: 'stale', suite: 'renamed-away' })
    );

    const loaded = loadArm(dir);
    expect(loaded.results).toEqual([
      {
        eval: 'build-docs-001',
        passed: true,
        checksPassed: 1,
        checksTotal: 2,
        resolvedCliVersion: '2.115.1-beta.6',
      },
    ]);
  });
});
