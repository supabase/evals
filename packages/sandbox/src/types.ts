import type { CommandResult } from "@supabase-evals/core";

/**
 * Result of a sandbox command. Aliased to core's `CommandResult` (structurally
 * identical) so the two never drift — the CLI-agent path passes sandbox results
 * straight through as `CommandResult`.
 */
export type SandboxCommandResult = CommandResult;

/**
 * Services the Supabase CLI can start, in the order the CLI documents them.
 * Used to compute the `supabase start -x <excluded>` flag from an include list.
 */
export const ALL_SUPABASE_SERVICES = [
  "gotrue",
  "realtime",
  "storage-api",
  "imgproxy",
  "kong",
  "mailpit",
  "postgrest",
  "postgres-meta",
  "studio",
  "edge-runtime",
  "logflare",
  "vector",
  "supavisor",
] as const;

export type SupabaseService = (typeof ALL_SUPABASE_SERVICES)[number];
