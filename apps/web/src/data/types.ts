export type EvalCheckResult = {
  name: string
  passed: boolean
  notes?: string
  judgeNotes?: string
}

export type EvalResult = {
  experiment: string
  eval: string
  stage?: string
  product?: string[]
  topic?: string[]
  suite?: string
  passed: boolean
  checks?: EvalCheckResult[]
  prompt?: string
  promptSourcePath?: string
  attempts?: number
  sourcePath: string
}
