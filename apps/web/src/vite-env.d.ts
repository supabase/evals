/// <reference types="vite/client" />

declare module "virtual:supabase-eval-results" {
  import type { EvalResult } from "eval-types"

  export type { EvalResult }

  const results: EvalResult[]
  export default results
}
