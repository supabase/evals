import type { CheckResult, ToolScorer } from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

const scorer: ToolScorer = async (ctx) => {
  const report = await ctx.judge({
    input: ctx.agentReport ?? '',
    rubric: stripIndent`
      Pass if the assistant's report satisfies all of these requirements:
      - Identifies disabled row-level security as one grouped security problem affecting both public.customer_contacts and public.invoices, at critical or error severity. It must not identify public.release_notes as affected by this problem.
      - Recommends enabling RLS and configuring appropriate access policies, without claiming to have applied changes.
      - Distinguishes completed security and performance checks from unavailable health checks. It must not claim health is clean or that all checks completed successfully. Reporting no performance findings is correct.

      Fail if either affected table is missing, the two findings are reported only as unrelated problems, or unavailable health coverage is omitted or presented as a healthy result.
    `,
  });

  const { rows } = await ctx.query(stripIndent`
    select c.relname as name, c.relrowsecurity as rls_enabled
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('customer_contacts', 'invoices', 'release_notes')
      and c.relkind = 'r'
    order by c.relname
  `);

  const checks: CheckResult[] = [
    {
      name: 'used project issues with warning-or-higher coverage across all checks',
      passed: ctx.toolCalls.some(
        ({ tool, body, error }) =>
          tool.kind === 'mcp' &&
          tool.server === 'supabase-mcp' &&
          tool.toolName === 'get_issues' &&
          body.type === 'all' &&
          body.severity === 'warning' &&
          !error
      ),
    },
    {
      name: 'reported grouped findings, remediation, and unavailable health coverage',
      passed: report.passed,
      judgeNotes: report.notes,
    },
    {
      name: 'left the affected tables and their RLS settings unchanged',
      passed:
        rows.length === 3 &&
        rows.every((row) => row.rls_enabled === (row.name === 'release_notes')),
    },
  ];

  return { passed: checks.every((check) => check.passed), checks };
};

export default scorer;
