// Run: pnpm --filter @supabase-evals/framework test:evals-lib
import { describe, expect, it } from 'vitest';
import type { ToolCallRecord } from '@supabase-evals/core';
import {
  checkMcpCallCount,
  checkNoMcpToolErrors,
  isToolError,
} from './mcp-tool-checks.js';

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
    ['a thrown error', { error: 'Payment required' }],
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

  it("ignores the agent's own MCP helpers", () => {
    const helper: ToolCallRecord = {
      tool: { kind: 'mcp', server: 'supabase', toolName: 'list_mcp_resources' },
      body: { server: 'supabase' },
      ts: 0,
      error: "resources/list failed: unknown MCP server 'supabase'",
    };
    expect(checkNoMcpToolErrors([helper]).passed).toBe(true);
  });

  it('fails on an MCP tool error', () => {
    expect(
      checkNoMcpToolErrors([
        call('create_branch', { error: 'Payment required' }),
      ]).passed
    ).toBe(false);
  });
});

describe('checkMcpCallCount', () => {
  const calls = [call('get_organization'), call('get_organization')];

  it('enforces a maximum', () => {
    expect(
      checkMcpCallCount(calls, 'get_organization', { max: 1 }).passed
    ).toBe(false);
    expect(checkMcpCallCount(calls, 'create_branch', { max: 0 }).passed).toBe(
      true
    );
  });

  it('enforces a minimum', () => {
    expect(
      checkMcpCallCount(calls, 'get_organization', { min: 1 }).passed
    ).toBe(true);
    expect(checkMcpCallCount(calls, 'get_cost', { min: 1 }).passed).toBe(false);
  });
});
