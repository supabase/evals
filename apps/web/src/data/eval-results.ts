import { createClient } from "@supabase/supabase-js"
import {
  evalResultSchema,
  type EvalResult,
} from "@supabase-evals/core/eval-metadata"

/**
 * Runtime read path for the leaderboard (AI-922): fetch results from the
 * Supabase eval-results store instead of importing a committed JSON file.
 *
 * Reads use the publishable key under the table's "public read" RLS policy.
 * Configure via Vite env (see apps/web/.env.example):
 *   VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY
 */
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_PUBLISHABLE_KEY = import.meta.env
  .VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

const TABLE = "eval_results"

// One row of public.eval_results (snake_case columns).
type EvalResultRow = {
  experiment: string
  eval: string
  experiment_suite: string | null
  agent: string | null
  model_provider: string | null
  model_id: string | null
  reasoning_effort: string | null
  stage: string | null
  product: string[] | null
  topic: string[] | null
  suite: string | null
  interface: string | null
  cli_version: string | null
  passed: boolean
  checks: unknown
  attempts: number | null
  skills: unknown
  prompt: string | null
  prompt_source_path: string | null
  source_path: string | null
}

// Rehydrate a DB row into the EvalResult candidate shape the app renders.
// Validated per-row by the caller with safeParse, so a single drifted row
// (e.g. a stale out-of-enum value after a rename) is dropped rather than
// throwing and blanking the whole leaderboard.
function rowToCandidate(row: EvalResultRow): unknown {
  return {
    experiment: row.experiment,
    eval: row.eval,
    experimentSuite: row.experiment_suite ?? undefined,
    experimentDisplay: row.agent
      ? {
          agent: row.agent,
          modelProvider: row.model_provider,
          modelId: row.model_id,
          reasoningEffort: row.reasoning_effort ?? undefined,
        }
      : undefined,
    stage: row.stage ?? undefined,
    product: row.product ?? undefined,
    topic: row.topic ?? undefined,
    suite: row.suite ?? undefined,
    interface: row.interface ?? undefined,
    cliVersion: row.cli_version ?? undefined,
    passed: row.passed,
    checks: row.checks ?? undefined,
    attempts: row.attempts ?? undefined,
    skills: row.skills ?? undefined,
    prompt: row.prompt ?? undefined,
    promptSourcePath: row.prompt_source_path ?? undefined,
    sourcePath: row.source_path ?? "",
  }
}

/**
 * Fetch every eval result from the store. Returns an empty array (and warns)
 * when the Supabase env isn't configured, the request fails, or every row fails
 * validation — so the app renders its empty state rather than crashing. Rows
 * that individually fail validation are dropped, not fatal.
 */
export async function fetchEvalResults(): Promise<EvalResult[]> {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    console.warn(
      "VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY are not set — no results to show.",
    )
    return []
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false },
  })

  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .order("experiment", { ascending: true })
    .order("eval", { ascending: true })

  if (error) {
    console.error(`Failed to load eval results: ${error.message}`)
    return []
  }

  const rows = data as EvalResultRow[]
  const results: EvalResult[] = []
  for (const row of rows) {
    const parsed = evalResultSchema.safeParse(rowToCandidate(row))
    if (parsed.success) {
      results.push(parsed.data)
    }
  }

  const skipped = rows.length - results.length
  if (skipped > 0) {
    console.warn(`Dropped ${skipped} eval result row(s) that failed validation.`)
  }
  return results
}
