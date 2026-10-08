import type { OrganizationSeed } from './organization.js';

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

export type MigrationSeed = { version: string; name: string; query: string };

export type ProjectSeed = {
  ref?: string;
  name?: string;
  sql?: string;
  /** Applied in order, before `sql`, and recorded in the migration history. */
  migrations?: MigrationSeed[];
  logs?: LogRow[];
  functions?: EdgeFunctionSeed[];
  pgvector?: boolean;
};

export type AppOptions = {
  seedDir?: string;
  projects?: ProjectSeed[];
  accessToken?: string;
  /** The single org every project belongs to; defaults to a free-plan org. */
  organization?: OrganizationSeed;
};
