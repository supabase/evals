// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/build-cli-004-worktree-stacks
import { describe, expect, it } from 'vitest';
import type { StackProbe } from '../lib/stack.js';
import { checkReportedPorts } from './report.js';
import type { WorktreeStacks } from './stacks.js';

function stack(port: number, apiPort?: number): StackProbe {
  return {
    ok: true,
    backend: 'managed',
    dbUrl: `postgresql://postgres:secret@127.0.0.1:${port}/postgres`,
    apiUrl: apiPort === undefined ? undefined : `http://127.0.0.1:${apiPort}`,
    runtime: 'native',
  };
}

const STACKS: WorktreeStacks = {
  'feature-a': stack(54322, 54321),
  'feature-b': stack(54332, 54331),
  'feature-c': stack(54342, 54341),
};

describe('checkReportedPorts', () => {
  it('passes when the report mentions each worktree database port', () => {
    const result = checkReportedPorts(
      STACKS,
      'feature-a: postgresql://postgres:postgres@127.0.0.1:54322/postgres, feature-b on port 54332, feature-c at 54342.'
    );
    expect(result).toEqual({
      name: 'reported ports match the running stacks',
      passed: true,
      notes:
        'feature-a db port 54322 reported, api port 54321 not reported; feature-b db port 54332 reported, api port 54331 not reported; feature-c db port 54342 reported, api port 54341 not reported',
    });
  });

  it('passes when the report gives API ports instead of database ports', () => {
    const result = checkReportedPorts(
      STACKS,
      'feature-a http://127.0.0.1:54321, feature-b http://127.0.0.1:54331, feature-c http://127.0.0.1:54341'
    );
    expect(result.passed).toBe(true);
  });

  it('accepts a different one of the two ports for each worktree', () => {
    const result = checkReportedPorts(
      STACKS,
      'feature-a 54321, feature-b 54332, feature-c 54341'
    );
    expect(result.passed).toBe(true);
  });

  it('falls back to the database port when the stack reported no API URL', () => {
    const noApi = { ...STACKS, 'feature-a': stack(54322) };
    expect(checkReportedPorts(noApi, 'a 54322, b 54332, c 54342').passed).toBe(
      true
    );
    expect(checkReportedPorts(noApi, 'a 54321, b 54332, c 54342').passed).toBe(
      false
    );
  });

  it('fails on an empty final message', () => {
    expect(checkReportedPorts(STACKS, '  \n')).toEqual({
      name: 'reported ports match the running stacks',
      passed: false,
      notes: 'the final message is empty',
    });
  });

  it('fails when the reported ports are not the real ones', () => {
    const result = checkReportedPorts(
      STACKS,
      'feature-a 54322, feature-b 54323, feature-c 54324'
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(
      'feature-b db port 54332 not reported, api port 54331 not reported'
    );
    expect(result.notes).toContain(
      'feature-c db port 54342 not reported, api port 54341 not reported'
    );
  });

  it('fails when a port only appears inside a longer number', () => {
    const result = checkReportedPorts(
      STACKS,
      'feature-a 54322, feature-b 54332, feature-c build 1543421'
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('feature-c db port 54342 not reported');
  });

  it('fails when a stack never resolved', () => {
    const result = checkReportedPorts(
      { ...STACKS, 'feature-c': { ok: false, notes: 'x' } },
      'feature-a 54322, feature-b 54332'
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('feature-c: stack did not resolve');
  });
});
