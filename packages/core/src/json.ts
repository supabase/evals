/**
 * Shared JSON helpers, imported both from within the core package and, via
 * the `@supabase-evals/core/json` subpath, by other packages (e.g.
 * `@supabase-evals/sandbox`'s CLI channel resolution) that want them without
 * pulling in core's much larger `index.ts`.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface JsonlRecords {
  records: Record<string, unknown>[];
  errors: string[];
}

/**
 * Parse newline-delimited JSON into object records, skipping blank lines and
 * collecting (not throwing on) per-line parse failures. Non-object JSON lines
 * (arrays, scalars) are ignored.
 */
export function parseJsonlRecords(raw: string): JsonlRecords {
  const records: Record<string, unknown>[] = [];
  const errors: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (isRecord(value)) records.push(value);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { records, errors };
}
