import {
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: public.user_refs.user_email references auth.users(email) — a non-PK
// unique column. Fix: change FK to auth.users(id) or drop the table.

const scorer: ToolScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkNoFkeyToAuthEmail(ctx),
    ];

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        { name: 'scorer evaluated fkey-to-auth-unique fix', passed: false, notes: msg },
      ],
    };
  }
};

export default scorer;

async function checkNoFkeyToAuthEmail(ctx: ToolEvalContext): Promise<CheckResult> {
  // Check if table is dropped entirely.
  const { rows: tableRows } = await ctx.query(stripIndent`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'user_refs';
  `);

  if (tableRows.length === 0) {
    return {
      name: 'no FK to app_users(email) — table dropped or restructured',
      passed: true,
      notes: 'user_refs table dropped',
    };
  }

  // Table still exists — check for FK referencing auth.users.email.
  const { rows } = await ctx.query(stripIndent`
    SELECT tc.constraint_name, kcu.column_name,
           ccu.table_schema AS foreign_schema,
           ccu.table_name AS foreign_table,
           ccu.column_name AS foreign_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name = 'user_refs'
      AND ccu.table_schema = 'public'
      AND ccu.table_name = 'app_users'
      AND ccu.column_name = 'email';
  `);

  return {
    name: 'no FK to app_users(email) — FK references id or table restructured',
    passed: rows.length === 0,
    notes: rows.length > 0
      ? `still has FK to app_users(email): ${rows.map(r => r.constraint_name).join(', ')}`
      : 'FK to email removed',
  };
}
