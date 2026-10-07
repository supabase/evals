import type { CheckResult } from '@supabase-evals/core';
import { findProjectDirs } from '../lib/projects.js';

export const CLIENTS = ['client-a', 'client-b'] as const;
export type Client = (typeof CLIENTS)[number];
export type ProjectDirs = Awaited<ReturnType<typeof findProjectDirs<Client>>>;

export function checkProjectsInitialised(dirs: ProjectDirs): CheckResult {
  const name =
    'client-a and client-b projects initialised (each has supabase/config.toml)';
  const resolved = CLIENTS.map((client) => dirs.found[client]);
  const allFound = resolved.every((dir) => dir !== undefined);
  const shared = allFound && new Set(resolved).size < CLIENTS.length;
  const perClient = CLIENTS.map(
    (client) =>
      `${client}: ${dirs.found[client] ?? dirs.problems[client] ?? 'not found'}`
  ).join('; ');
  if (allFound && !shared) return { name, passed: true, notes: perClient };
  return {
    name,
    passed: false,
    notes: `${perClient}${shared ? ' (both resolved to the same directory)' : ''}; supabase/config.toml found under: ${
      dirs.all.length > 0 ? dirs.all.join(', ') : 'none'
    }`,
  };
}
