import {
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: public.cached_relations has a 'relation_oid' column of type regclass.
// The fix changes the column type to text (storing the relation name).

const scorer: ToolScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkNoRegclassColumn(ctx),
      await checkTableStillExists(ctx),
    ];

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        { name: 'scorer evaluated reg types fix', passed: false, notes: msg },
      ],
    };
  }
};

export default scorer;

async function checkNoRegclassColumn(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'cached_relations'
      AND udt_name IN ('regclass', 'regproc', 'regtype', 'regprocedure', 'regoper', 'regoperator', 'regconfig', 'regdictionary');
  `);
  return {
    name: 'no regclass/reg* columns remain in public.cached_relations',
    passed: rows.length === 0,
    notes: rows.length > 0
      ? `still has reg* columns: ${rows.map(r => `${r.column_name}:${r.udt_name}`).join(', ')}`
      : 'none found',
  };
}

async function checkTableStillExists(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'cached_relations';
  `);
  return {
    name: 'public.cached_relations table still exists',
    passed: rows.length === 1,
  };
}
