import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';

const FUNCTION = 'order_total';

export type FunctionRow = {
  name: string;
  isDefiner: boolean;
  config: string;
  args: string;
  argCount: number;
  firstArgName: string;
  body: string;
  anonCanExecute: boolean;
};

export async function loadFunctions(
  ctx: LocalStackEvalContext
): Promise<FunctionRow[]> {
  const { rows } = await ctx.query(`
    SELECT p.proname AS name,
           p.prosecdef AS is_definer,
           COALESCE(array_to_string(p.proconfig, ','), '') AS config,
           pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
           p.pronargs AS arg_count,
           COALESCE(p.proargnames[1], '') AS first_arg_name,
           -- pg_get_functiondef renders a standard-body function too, where
           -- prosrc is null. to_regrole yields null rather than erroring when
           -- anon is absent, and has_function_privilege is strict, so a stack
           -- without the role reads as no execute rather than a failed scorer.
           COALESCE(pg_catalog.pg_get_functiondef(p.oid), p.prosrc, '') AS body,
           COALESCE(
             pg_catalog.has_function_privilege(
               pg_catalog.to_regrole('anon'), p.oid, 'EXECUTE'
             ),
             false
           ) AS anon_can_execute
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = '${FUNCTION}';
  `);

  return rows.map((row) => ({
    name: String(row.name),
    isDefiner: row.is_definer === true || row.is_definer === 't',
    config: String(row.config ?? ''),
    args: String(row.args ?? ''),
    argCount: Number(row.arg_count ?? 0),
    firstArgName: String(row.first_arg_name ?? ''),
    body: String(row.body ?? ''),
    anonCanExecute:
      row.anon_can_execute === true || row.anon_can_execute === 't',
  }));
}

export function pickArgumentName(functions: FunctionRow[]): string | undefined {
  return functions.find((fn) => fn.argCount === 1 && fn.firstArgName !== '')
    ?.firstArgName;
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

// The caller's identity, however a body reaches for it. auth.uid() and
// auth.jwt() are themselves defined in terms of request.jwt.claim, so the third
// alternative resolves them and anything else built the same way.
const CALLER_IDENTITY = /auth\s*\.\s*(uid|jwt)\s*\(|request\.jwt\.claim/i;

// Every function the stack did not install, so a body that delegates its
// ownership check can be followed one hop. The skills guidance tells agents to
// put that check in a helper in a non-exposed schema, so the delegating shape
// is the recommended one rather than an edge case, and a scan of order_total's
// own text reds it. Extension-owned functions are anti-joined out: pg_depend
// deptype 'e' is what marks them, and pg_get_functiondef raises on some.
export async function loadIdentityHelpers(
  ctx: LocalStackEvalContext
): Promise<string[]> {
  const { rows } = await ctx.query(`
    SELECT p.proname AS name,
           COALESCE(pg_catalog.pg_get_functiondef(p.oid), p.prosrc, '') AS body
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND p.prokind = 'f'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.objid = p.oid AND d.deptype = 'e'
      );
  `);

  return rows
    .filter((row) => CALLER_IDENTITY.test(String(row.body ?? '')))
    .map((row) => String(row.name))
    .filter((name) => name !== '' && name !== FUNCTION);
}

export function checkDesignAccountsForCaller(
  functions: FunctionRow[],
  identityHelpers: string[]
): CheckResult {
  const name = "the function's design accounts for who is calling";

  if (functions.length === 0) {
    return {
      name,
      passed: false,
      notes: `no function named ${FUNCTION} in public`,
    };
  }

  const open = functions.filter(
    (fn) =>
      fn.isDefiner && !readsCaller(fn, identityHelpers) && fn.anonCanExecute
  );

  return {
    name,
    passed: open.length === 0,
    notes:
      open.length > 0
        ? `runs as its creator, never reads the caller's identity, and is still executable by anon: ${open.map((fn) => fn.name).join(', ')}`
        : functions.map((fn) => mechanism(fn, identityHelpers)).join(', '),
  };
}

function readsCaller(fn: FunctionRow, identityHelpers: string[]): boolean {
  if (CALLER_IDENTITY.test(fn.body)) return true;
  return identityHelpers.some((helper) =>
    new RegExp(`\\b${escapeRegExp(helper)}\\s*\\(`, 'i').test(fn.body)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mechanism(fn: FunctionRow, identityHelpers: string[]): string {
  if (!fn.isDefiner) return `${fn.name} runs as its caller`;
  if (readsCaller(fn, identityHelpers)) {
    return `${fn.name} runs as its creator and reads the caller's identity`;
  }
  return `${fn.name} runs as its creator and is not executable by anon`;
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
      functions.length === 0
        ? `not applicable: no function named ${FUNCTION} in public`
        : definers.length === 0
          ? `not applicable: ${FUNCTION} runs as its caller`
          : unpinned.length > 0
            ? `runs as its creator with no search path pinned: ${unpinned.map((fn) => fn.name).join(', ')}`
            : `pinned: ${definers.map((fn) => fn.config).join(', ')}`,
  };
}
