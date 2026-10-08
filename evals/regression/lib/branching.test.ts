// Run: pnpm --filter @supabase-evals/framework test:evals-lib
import type { ToolCallRecord } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  checkCostFlowBeforeFirstBranch,
  checkOneUnavailableResult,
} from './branching.js';

const call = (
  toolName: string,
  outcome: Partial<Pick<ToolCallRecord, 'result' | 'error'>> = {}
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

describe('checkOneUnavailableResult', () => {
  const unavailable = {
    content: [
      {
        type: 'text',
        text: "Branching isn't available. Upgrade at https://supabase.com/dashboard/org/acme/billing",
      },
    ],
  };

  it('passes on one non-error unavailable result from any branching tool', () => {
    expect(
      checkOneUnavailableResult([
        call('list_branches', { result: unavailable }),
      ]).passed
    ).toBe(true);
  });

  it('fails when the agent keeps calling after the first answer', () => {
    expect(
      checkOneUnavailableResult([
        call('list_branches', { result: unavailable }),
        call('create_branch', { result: unavailable }),
      ]).passed
    ).toBe(false);
  });

  it('fails when the same answer comes back as an error', () => {
    expect(
      checkOneUnavailableResult([
        call('create_branch', { result: { ...unavailable, isError: true } }),
      ]).passed
    ).toBe(false);
  });
});
