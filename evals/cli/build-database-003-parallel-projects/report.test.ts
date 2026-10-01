// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/build-database-003-parallel-projects
import { describe, expect, it } from 'vitest';
import type { StackProbe } from '../lib/stack.js';
import { checkReportedPorts, describeGroundTruth } from './report.js';
import type { ClientStacks } from './stacks.js';

function stack(dbPort: number, apiPort?: number): StackProbe {
  return {
    ok: true,
    backend: 'managed',
    dbUrl: `postgresql://postgres:secret@127.0.0.1:${dbPort}/postgres`,
    apiUrl: apiPort === undefined ? undefined : `http://127.0.0.1:${apiPort}`,
    runtime: 'native',
  };
}

const STACKS: ClientStacks = {
  'client-a': stack(54322, 54321),
  'client-b': stack(54332, 54331),
};

describe('checkReportedPorts', () => {
  it('passes when the report mentions both real API ports', () => {
    const result = checkReportedPorts(
      STACKS,
      'client-a is on http://127.0.0.1:54321 and client-b is on port 54331.'
    );
    expect(result).toEqual({
      name: 'reported api ports match the running stacks',
      passed: true,
      notes:
        'client-a api port 54321: reported; client-b api port 54331: reported',
    });
  });

  it('fails when one real port is missing', () => {
    const result = checkReportedPorts(STACKS, 'client-a is on 54321.');
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('client-b api port 54331: not reported');
  });

  it('fails when a port only appears inside a longer number', () => {
    const result = checkReportedPorts(
      STACKS,
      'client-a is on 54321; client-b build id 1543310.'
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('client-b api port 54331: not reported');
  });

  it('fails with a clear note when a resolved stack reported no API URL', () => {
    const result = checkReportedPorts(
      { 'client-a': stack(54322), 'client-b': STACKS['client-b'] },
      'client-a 54321, client-b 54331'
    );
    expect(result).toEqual({
      name: 'reported api ports match the running stacks',
      passed: false,
      notes: 'client-a: stack resolved via managed but reported no API URL',
    });
  });

  it('fails when a stack never resolved', () => {
    const result = checkReportedPorts(
      { 'client-a': STACKS['client-a'], 'client-b': { ok: false, notes: 'x' } },
      'client-a 54321'
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toBe('client-b: stack did not resolve');
  });
});

describe('describeGroundTruth', () => {
  it('lists backend, ports, and rows per project without credentials', () => {
    const lines = describeGroundTruth(
      {
        'client-a': STACKS['client-a'],
        'client-b': { ok: false, notes: 'down' },
      },
      {
        'client-a': { ok: true, values: ['client-a'] },
        'client-b': { ok: false, notes: 'down' },
      }
    );
    expect(lines).toEqual([
      '- client-a: stack resolved: managed/native\n  db port: 54322\n  api port: 54321\n  clients rows: ["client-a"]',
      '- client-b: stack none (down)\n  db port: unavailable\n  api port: unavailable\n  clients rows: unavailable (down)',
    ]);
    expect(lines.join('\n')).not.toContain('secret');
  });
});
