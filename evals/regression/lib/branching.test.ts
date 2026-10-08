// Run: pnpm --filter @supabase-evals/framework test:evals-lib
import type { ToolCallRecord } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  checkCostFlowBeforeFirstBranch,
  checkStoppedAfterUnavailable,
} from './branching.js';

const call = (
  toolName: string,
  outcome: Partial<
    Pick<ToolCallRecord, 'result' | 'error' | 'ts' | 'resultTs'>
  > = {}
): ToolCallRecord => ({
  tool: { kind: 'mcp', server: 'supabase-mcp', toolName },
  body: {},
  ts: 0,
  ...outcome,
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

  it('judges the first successful branch', () => {
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

describe('checkStoppedAfterUnavailable', () => {
  const result = {
    content: [
      {
        type: 'text',
        text: "Branching isn't available. Upgrade at https://supabase.com/dashboard/org/acme/billing",
      },
    ],
  };

  it('passes on parallel first calls that both get the answer', () => {
    expect(
      checkStoppedAfterUnavailable([
        call('list_branches', { result, ts: 100, resultTs: 130 }),
        call('get_cost', { result, ts: 101, resultTs: 129 }),
      ]).passed
    ).toBe(true);
  });

  it('fails when the agent tries again after the answer', () => {
    expect(
      checkStoppedAfterUnavailable([
        call('list_branches', { result, ts: 100, resultTs: 130 }),
        call('create_branch', { result, ts: 500, resultTs: 530 }),
      ]).passed
    ).toBe(false);
  });

  it('fails when the same answer comes back as an error', () => {
    expect(
      checkStoppedAfterUnavailable([
        call('create_branch', { result: { ...result, isError: true } }),
      ]).passed
    ).toBe(false);
  });

  it('fails without any unavailable answer', () => {
    expect(checkStoppedAfterUnavailable([call('list_projects')]).passed).toBe(
      false
    );
  });
});
