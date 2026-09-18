export type LogRow = {
  id?: string;
  ts: Date;
  source: string;
  level: string;
  message: string;
  metadata?: Record<string, unknown>;
};

export type EdgeFunctionSeed = {
  slug: string;
  name?: string;
  verify_jwt?: boolean;
  files: Array<{ name: string; content: string }>;
};

export type ProjectSeed = {
  ref?: string;
  name?: string;
  sql?: string;
  logs?: LogRow[];
  functions?: EdgeFunctionSeed[];
  pgvector?: boolean;
};

export type AppOptions = {
  seedDir?: string;
  projects?: ProjectSeed[];
  accessToken?: string;
  /** Regions that refuse project creation with the platform's 503 and show as at capacity. */
  unavailableRegions?: string[];
};
