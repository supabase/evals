import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';

export const ORDER_TOTAL = 'order_total';
export const CREDIT_BALANCE = 'credit_balance';

export type FunctionRow = {
  name: string;
  isDefiner: boolean;
  config: string;
  args: string;
  argCount: number;
  firstArgName: string;
};

export async function loadFunctions(
  ctx: LocalStackEvalContext,
  name: string
): Promise<FunctionRow[]> {
  const { rows } = await ctx.query(`
    SELECT p.proname AS name,
           p.prosecdef AS is_definer,
           COALESCE(array_to_string(p.proconfig, ','), '') AS config,
           pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
           p.pronargs AS arg_count,
           COALESCE(p.proargnames[1], '') AS first_arg_name
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = '${name}';
  `);

  return rows.map((row) => ({
    name: String(row.name),
    isDefiner: row.is_definer === true || row.is_definer === 't',
    config: String(row.config ?? ''),
    args: String(row.args ?? ''),
    argCount: Number(row.arg_count ?? 0),
    firstArgName: String(row.first_arg_name ?? ''),
  }));
}

export function pickArgumentName(functions: FunctionRow[]): string | undefined {
  return functions.find((fn) => fn.argCount === 1 && fn.firstArgName !== '')
    ?.firstArgName;
}

export function checkFunctionExists(
  functions: FunctionRow[],
  name: string
): CheckResult {
  return {
    name: `the database has ${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name} function`,
    passed: functions.length > 0,
    notes:
      functions.length > 0
        ? functions.map((fn) => `${fn.name}(${fn.args})`).join(', ')
        : `no function named ${name} in public`,
  };
}

// Ranges over every function the prompt asks for. Reports itself not applicable
// when none of them runs as its creator.
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
      functions.length === 0
        ? `not applicable: no function named ${ORDER_TOTAL} or ${CREDIT_BALANCE} in public`
        : definers.length === 0
          ? `not applicable: ${functions.map((fn) => fn.name).join(', ')} run as the caller`
          : unpinned.length > 0
            ? `runs as its creator with no search path pinned: ${unpinned.map((fn) => fn.name).join(', ')}`
            : `pinned: ${definers.map((fn) => `${fn.name} ${fn.config}`).join(', ')}`,
  };
}
