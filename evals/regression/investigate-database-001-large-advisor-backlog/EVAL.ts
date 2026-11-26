import {
  serializeTranscript,
  type CheckResult,
  type ToolCallRecord,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

/**
 * The seed is shaped like the Mockamaster capture in supabase/mcp#546: 547
 * advisor findings across 11 lints, 8 of them warning or worse. Ungrouped
 * advisor output for a project this size is ~364KB, past the 25k-token tool
 * output limit, so the agent gets an error instead of the issues.
 * Grouped get_issues (supabase/mcp#546) measured 66.3KB on the default
 * call, 11 issues. The bound sits near
 * the 25k-token limit so a regression to ungrouped output fails here.
 *
 * Some clients spill results over ~50KB to a file and hand the agent a
 * preview plus the path. That is not truncation: the agent can still read
 * the whole result. The size is taken from the spill notice in that case.
 */
const MAX_RESULT_CHARS = 100_000;

const TRUNCATION_MARKERS = ['exceeds maximum allowed tokens'];

const SPILL_SIZE = /Output too large \(([\d.]+)(KB|MB)\)/;

const resultSize = (text: string) => {
  const spill = text.match(SPILL_SIZE);
  if (!spill) return text.length;
  return Math.round(Number(spill[1]) * (spill[2] === 'MB' ? 1_000_000 : 1_000));
};

const isIssuesCall = (call: ToolCallRecord) =>
  call.tool.kind === 'mcp' && call.tool.toolName === 'get_issues';

const resultText = (call: ToolCallRecord) =>
  typeof call.result === 'string'
    ? call.result
    : (JSON.stringify(call.result) ?? '');

const scorer: ToolScorer = async (ctx) => {
  const input = serializeTranscript(ctx.transcript);
  const issuesCalls = ctx.toolCalls.filter(isIssuesCall);
  const sizes = issuesCalls.map((call) => resultSize(resultText(call)));
  const largest = sizes.length ? Math.max(...sizes) : 0;
  const truncated = issuesCalls.some((call) =>
    TRUNCATION_MARKERS.some((m) => resultText(call).includes(m))
  );

  const priority = await ctx.judge({
    input,
    rubric: stripIndent`
      Pass if the assistant names enabling row-level security on the public.payments table as the first thing to fix, and explains why: the table is exposed to anyone with the anon key through the API. The three critical/ERROR issues (RLS disabled in public, a policy that exists while RLS is disabled, and a security definer view) all trace back to public.payments, and the assistant must treat them as one problem with one fix, not three unrelated ones. It must rank this ahead of the high-volume warnings (unindexed foreign keys, auth RLS initplan, multiple permissive policies, mutable function search_path, duplicate indexes, tables without policies or primary keys).

      Fail if the assistant does not mention public.payments, picks a high-count warning or performance lint as the top priority, treats the payments policy or view as a separate first fix while leaving RLS off, says it could not read the issues because the output was too large, or lists findings without choosing one to fix first.
    `,
  });

  const checks: CheckResult[] = [
    {
      name: 'called get_issues',
      passed: issuesCalls.length > 0,
    },
    {
      name: `get_issues output stayed under ${MAX_RESULT_CHARS} chars and was not truncated`,
      passed: issuesCalls.length > 0 && largest <= MAX_RESULT_CHARS && !truncated,
      judgeNotes: `largest get_issues result: ${largest} chars${truncated ? ' (truncated by the agent harness)' : ''}`,
    },
    {
      name: 'ranked enabling RLS on public.payments as the first fix',
      passed: priority.passed,
      judgeNotes: priority.notes,
    },
  ];

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
};

export default scorer;
