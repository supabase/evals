/// <reference types="vite/client" />

declare module "virtual:supabase-eval-results" {
  type AssertionResult = {
    type: "deterministic" | "llm"
    name: string
    passed: boolean
    notes?: string
  }

  type EvalResult = {
    experiment: string
    eval: string
    stage?: "design" | "deploy" | "observe" | "detect" | "resolve"
    product?: string[]
    topic?: string[]
    passed: boolean
    assertions?: AssertionResult[]
    prompt?: string
    promptSourcePath?: string
    attempts?: number
    sourcePath: string
  }

  export type { EvalResult }

  const results: EvalResult[]
  export default results
}
