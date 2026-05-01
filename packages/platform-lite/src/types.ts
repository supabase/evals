export type LogRow = {
  ts: Date
  source: string
  level: string
  message: string
  metadata?: Record<string, unknown>
}

export type ProjectSeed = {
  ref?: string
  name?: string
  sql?: string
  logs?: LogRow[]
}

export type AppOptions = {
  seedDir?: string
  projects?: ProjectSeed[]
  accessToken?: string
}
