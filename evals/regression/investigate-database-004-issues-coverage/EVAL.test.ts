import type { ToolEvalContext } from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import scorer from './EVAL.js';

function context() {
  return {
    toolCalls: [
      {
        tool: {
          kind: 'mcp',
          server: 'supabase-mcp',
          toolName: 'get_issues',
        },
        body: { type: 'all', severity: 'warning' },
        ts: 1,
      },
    ],
    agentReport: 'The final issue report',
    query: vi.fn().mockResolvedValue({
      rows: [
        { name: 'customer_contacts', rls_enabled: false },
        { name: 'invoices', rls_enabled: false },
        { name: 'release_notes', rls_enabled: true },
      ],
    }),
    judge: vi
      .fn()
      .mockResolvedValue({ passed: true, notes: 'Complete report' }),
  } satisfies Partial<ToolEvalContext>;
}

describe('Issues Inbox report scorer', () => {
  it('accepts the requested call and a complete report without changing RLS', async () => {
    const ctx = context();

    expect((await scorer(ctx as ToolEvalContext)).passed).toBe(true);
    expect(ctx.judge).toHaveBeenCalledWith(
      expect.objectContaining({ input: ctx.agentReport })
    );
  });

  it.each([
    { toolName: 'get_advisors', type: 'all', severity: 'warning' },
    { toolName: 'get_issues', type: 'security', severity: 'warning' },
    { toolName: 'get_issues', type: 'all', severity: 'critical' },
  ])('rejects incomplete retrieval: %j', async ({ toolName, ...body }) => {
    const ctx = context();
    ctx.toolCalls[0]!.tool.toolName = toolName;
    ctx.toolCalls[0]!.body = body;

    expect((await scorer(ctx as ToolEvalContext)).passed).toBe(false);
  });

  it('rejects a report that omits affected resources or unavailable health coverage', async () => {
    const ctx = context();
    ctx.judge.mockResolvedValue({ passed: false, notes: 'Incomplete report' });

    expect((await scorer(ctx as ToolEvalContext)).passed).toBe(false);
  });

  it('rejects changes to the affected RLS settings even with a complete report', async () => {
    const ctx = context();
    ctx.query.mockResolvedValue({
      rows: [
        { name: 'customer_contacts', rls_enabled: true },
        { name: 'invoices', rls_enabled: false },
        { name: 'release_notes', rls_enabled: true },
      ],
    });

    expect((await scorer(ctx as ToolEvalContext)).passed).toBe(false);
  });
});
