// Run: pnpm --filter @supabase-evals/framework test:regression-lib
import type { ToolCallRecord } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  checkCallCount,
  checkCostFlowBeforeFirstBranch,
  checkNoMcpToolErrors,
  isToolError,
} from './mcp-calls.js';

const call = (
  toolName: string,
  outcome: Partial<Pick<ToolCallRecord, 'result' | 'error'>> = {}
): ToolCallRecord => ({
  tool: { kind: 'mcp', server: 'supabase-mcp', toolName },
  body: {},
  ts: 0,
  ...outcome,
});

describe('isToolError', () => {
  it.each([
    [
      'a thrown error',
      { error: 'Branching is supported only on the Pro plan' },
    ],
    ['an isError result', { result: { isError: true, content: [] } }],
    ['an isError result as a JSON string', { result: '{"isError":true}' }],
  ])('flags %s', (_, outcome) => {
    expect(isToolError(call('create_branch', outcome))).toBe(true);
  });

  it.each([
    [
      'a non-error refusal',
      {
        result: {
          content: [{ type: 'text', text: 'Branching requires the Pro plan.' }],
        },
      },
    ],
    ['an explicit isError: false', { result: { isError: false } }],
    ['a plain string', { result: 'Branching requires the Pro plan.' }],
    ['no result', {}],
  ])('passes %s', (_, outcome) => {
    expect(isToolError(call('create_branch', outcome))).toBe(false);
  });
});

describe('checkNoMcpToolErrors', () => {
  it('ignores errors from non-MCP tools', () => {
    const shell: ToolCallRecord = {
      tool: { kind: 'other', toolName: 'bash' },
      body: {},
      ts: 0,
      error: 'exit 1',
    };
    expect(checkNoMcpToolErrors([shell, call('get_organization')]).passed).toBe(
      true
    );
  });

  it('fails on an MCP tool error', () => {
    expect(
      checkNoMcpToolErrors([
        call('create_branch', { error: 'Payment required' }),
      ]).passed
    ).toBe(false);
  });
});

describe('checkCallCount', () => {
  const calls = [call('get_organization'), call('get_organization')];

  it('enforces a maximum', () => {
    expect(checkCallCount(calls, 'get_organization', { max: 1 }).passed).toBe(
      false
    );
    expect(checkCallCount(calls, 'create_branch', { max: 0 }).passed).toBe(
      true
    );
  });

  it('enforces a minimum', () => {
    expect(checkCallCount(calls, 'get_organization', { min: 1 }).passed).toBe(
      true
    );
    expect(checkCallCount(calls, 'get_cost', { min: 1 }).passed).toBe(false);
  });
});

describe('checkCostFlowBeforeFirstBranch', () => {
  const passes = (calls: ToolCallRecord[]) =>
    checkCostFlowBeforeFirstBranch(calls).passed;

  it('passes get_cost -> confirm_cost -> create_branch', () => {
    expect(
      passes([
        call('get_organization'),
        call('get_cost'),
        call('confirm_cost'),
        call('create_branch'),
        call('create_branch'),
      ])
    ).toBe(true);
  });

  it('fails without a branch', () => {
    expect(passes([call('get_cost'), call('confirm_cost')])).toBe(false);
  });

  it('fails when confirm_cost is skipped', () => {
    expect(passes([call('get_cost'), call('create_branch')])).toBe(false);
  });

  it('fails when get_cost comes after confirm_cost', () => {
    expect(
      passes([call('confirm_cost'), call('get_cost'), call('create_branch')])
    ).toBe(false);
  });

  it('judges the first successful branch, not a failed attempt', () => {
    expect(
      passes([
        call('create_branch', { error: 'confirm_cost_id required' }),
        call('get_cost'),
        call('confirm_cost'),
        call('create_branch'),
      ])
    ).toBe(true);
  });
});
