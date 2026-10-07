// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/build-database-003-parallel-projects
import type { TranscriptPart } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import type { StackProbe } from '../lib/stack.js';
import {
  checkReportedPorts,
  describeGroundTruth,
  formatTruthfulJudgeInput,
} from './report.js';
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

describe('formatTruthfulJudgeInput', () => {
  it('includes ground truth and tool call outputs and errors', () => {
    const transcript: TranscriptPart[] = [
      {
        type: 'tool_call',
        name: 'bash',
        input: { command: 'supabase start' },
        error: 'Cannot connect to the Docker daemon',
      },
      {
        type: 'tool_call',
        name: 'bash',
        input: { command: 'supabase status' },
        output: 'API URL: http://127.0.0.1:54321',
      },
      { type: 'message', role: 'assistant', content: 'Docker is down.' },
    ];
    const input = formatTruthfulJudgeInput(
      ['- client-a: stack none'],
      transcript
    );
    expect(input).toContain('- client-a: stack none');
    expect(input).toContain('supabase start');
    expect(input).toContain('Cannot connect to the Docker daemon');
    expect(input).toContain('API URL: http://127.0.0.1:54321');
  });
});

describe('describeGroundTruth with relocated homes and CLI overrides', () => {
  const rows = {
    'client-a': { ok: true as const, values: ['client-a'] },
    'client-b': { ok: false as const, notes: 'down' },
  };

  it('states that a project was found under a relocated home', () => {
    const lines = describeGroundTruth(
      {
        'client-a': {
          ...(stack(54322, 54321) as object),
          relocatedHome: '/s/.h',
        } as StackProbe,
        'client-b': { ok: false, notes: 'down' },
      },
      rows
    );
    expect(lines[0]).toContain(
      "stack resolved: managed/native under the agent's relocated CLI home /s/.h"
    );
  });

  const RUNNER = 'npx --yes supabase@2.120.0';
  const swapNote = `agent ran ${RUNNER}; scorer uses the installed CLI`;

  it('notes only projects whose latest start ran through an override runner', () => {
    const invocations = findSupabaseInvocations([
      { command: `${RUNNER} start`, cwd: '/s/client-a' },
      { command: 'supabase start', cwd: '/s/client-b' },
    ]);
    const lines = describeGroundTruth(
      {
        'client-a': stack(54322, 54321),
        'client-b': { ok: false, notes: 'port 54322 already in use' },
      },
      rows,
      [RUNNER],
      invocations
    );
    expect(lines[0]).toContain(swapNote);
    expect(lines[0]).not.toContain('may be running without being reachable');
    expect(lines[1]).not.toContain(swapNote);
    expect(lines[1]).not.toContain('may be running without being reachable');
  });

  it('warns that an unresolved override-started project may still be running', () => {
    const invocations = findSupabaseInvocations([
      { command: `${RUNNER} start --workdir client-b`, cwd: '/s' },
    ]);
    const lines = describeGroundTruth(
      {
        'client-a': stack(54322, 54321),
        'client-b': { ok: false, notes: 'down' },
      },
      rows,
      [RUNNER],
      invocations
    );
    expect(lines[0]).not.toContain(swapNote);
    expect(lines[1]).toContain(
      `${swapNote}, so the project may be running without being reachable by the harness`
    );
  });

  it('adds no note without invocations to attribute', () => {
    const lines = describeGroundTruth(
      { 'client-a': stack(54322, 54321), 'client-b': stack(54332, 54331) },
      rows,
      [RUNNER]
    );
    expect(lines.join('\n')).not.toContain('agent ran');
  });
});
