export type LogRow = {
  id?: string
  ts: Date
  source: string
  level: string
  message: string
  metadata?: Record<string, unknown>
}

export type EdgeFunctionSeed = {
  slug: string
  name?: string
  verify_jwt?: boolean
  files: Array<{ name: string; content: string }>
}

export type ProjectSeed = {
  ref?: string
  name?: string
  sql?: string
  logs?: LogRow[]
  functions?: EdgeFunctionSeed[]
  pgvector?: boolean
}

export type AppOptions = {
  seedDir?: string
  projects?: ProjectSeed[]
  accessToken?: string
}
