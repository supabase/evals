import { z } from 'zod';
import platformLitePackage from '../package.json' with { type: 'json' };

export { createPlatform } from './app.js';
export type { PlatformHandle, ServerHandle, PgServerHandle } from './app.js';
export type {
  AppOptions,
  ProjectSeed,
  LogRow,
  EdgeFunctionSeed,
} from './types.js';
export type { ListenOptions } from './listen.js';
export type { ProjectInstance } from './project/ProjectInstance.js';
export { createManagementApiClient } from './management-api/client.js';
export type { ManagementApiClient } from './management-api/client.js';
export { loadFunctionSeeds } from './seed.js';
export const MCP_SERVER_VERSION = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
    'MCP version must be an exact stable version'
  )
  .parse(platformLitePackage.devDependencies['@supabase/mcp-server-supabase']);
