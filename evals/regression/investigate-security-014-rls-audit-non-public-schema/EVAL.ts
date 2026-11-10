import type { CheckResult, ToolScorer } from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// RLS audit completeness (supabase/mcp#395). Three seeded tables lack RLS:
// public.support_tickets, and billing.invoices and billing.payment_methods in
// a second schema. `list_tables` with no `schemas` argument returns only
// `public`, so an agent that trusts its "defaults to all schemas" description
// reports one table and misses the two that hold payment data.
//
// Scoring is deterministic and checks the final answer, not the process: any
// discovery path is fine (list_tables with schemas, `schemas: []`, SQL against
// the catalog, advisors). Each table counts as reported when its name appears
// in the answer, so list, table and prose formats all pass.

const UNPROTECTED = [
  { schema: 'public', table: 'support_tickets' },
  { schema: 'billing', table: 'invoices' },
  { schema: 'billing', table: 'payment_methods' },
] as const;

const truthy = (v: unknown) => v === true || v === 't' || v === 'true';

const mentions = (report: string, table: string) =>
  new RegExp(`\\b${table}\\b`, 'i').test(report);

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';

  // Independent catalog check: the seeded ground truth still holds. The prompt
  // says not to change anything, so the agent enabling RLS is a failure too.
  const { rows } = await ctx.query(stripIndent`
    SELECT n.nspname AS schema, c.relname AS table, c.relrowsecurity AS rls
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND n.nspname IN ('public', 'billing')
  `);
  const rlsOff = new Set(
    rows
      .filter((r) => !truthy(r.rls))
      .map((r) => `${String(r.schema)}.${String(r.table)}`)
  );
  const stateUnchanged = UNPROTECTED.every((t) =>
    rlsOff.has(`${t.schema}.${t.table}`)
  );

  const perTable: CheckResult[] = UNPROTECTED.map((t) => ({
    name: `reports ${t.schema}.${t.table}`,
    passed: mentions(report, t.table),
  }));

  // Informational: did the agent look past `public` at all?
  const lookedBeyondPublic = ctx.toolCalls.some((tc) => {
    const body = JSON.stringify(tc.body ?? {});
    if (tc.tool.toolName === 'list_tables') {
      const schemas = (tc.body as { schemas?: unknown }).schemas;
      return (
        Array.isArray(schemas) &&
        (schemas.length === 0 || schemas.some((s) => s !== 'public'))
      );
    }
    return /billing|pg_class|pg_tables|information_schema\.tables/i.test(body);
  });

  const checks: CheckResult[] = [
    { name: 'left RLS settings unchanged', passed: stateUnchanged },
    ...perTable,
    { name: 'inspected schemas beyond public', passed: lookedBeyondPublic },
  ];

  return {
    passed: stateUnchanged && perTable.every((c) => c.passed),
    checks,
  };
};

export default scorer;
