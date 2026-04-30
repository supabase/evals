export type EvalResult = {
  experiment: string
  eval: string
  passed: boolean
  score?: number
  notes?: string
  prompt?: string
  promptSourcePath?: string
  attempts?: number
  sourcePath: string
}
