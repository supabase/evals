import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';

const FUNCTION = 'order_total';

export type FunctionRow = {
  name: string;
  isDefiner: boolean;
  config: string;
  args: string;
};

export async function loadFunctions(
  ctx: LocalStackEvalContext
): Promise<FunctionRow[]> {
  const { rows } = await ctx.query(`
    SELECT p.proname AS name,
           p.prosecdef AS is_definer,
           COALESCE(array_to_string(p.proconfig, ','), '') AS config,
           pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = '${FUNCTION}';
  `);

  return rows.map((row) => ({
    name: String(row.name),
    isDefiner: row.is_definer === true || row.is_definer === 't',
    config: String(row.config ?? ''),
    args: String(row.args ?? ''),
  }));
}

export function checkFunctionExists(functions: FunctionRow[]): CheckResult {
  return {
    name: 'the database has an order_total function',
    passed: functions.length > 0,
    notes:
      functions.length > 0
        ? functions.map((fn) => `${fn.name}(${fn.args})`).join(', ')
        : `no function named ${FUNCTION} in public`,
  };
}

export function checkDefinerPinsSearchPath(
  functions: FunctionRow[]
): CheckResult {
  const definers = functions.filter((fn) => fn.isDefiner);
  const unpinned = definers.filter(
    (fn) => !/(^|,)search_path=/.test(fn.config)
  );

  return {
    name: 'a function that runs as its creator pins its search path',
    passed: unpinned.length === 0,
    notes:
      definers.length === 0
        ? 'not applicable: order_total runs as its caller'
        : unpinned.length > 0
          ? `runs as its creator with no search path pinned: ${unpinned.map((fn) => fn.name).join(', ')}`
          : `pinned: ${definers.map((fn) => fn.config).join(', ')}`,
  };
}
