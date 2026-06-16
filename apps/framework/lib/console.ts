/**
 * Run a function with `console.error` suppressed.
 *
 * Useful when the function triggers supabase-js operations that are *expected*
 * to fail (e.g. a cross-user write blocked by RLS) — supabase-js logs those
 * via `console.error` even though they're handled as values, producing noise
 * that buries real output. Scorers and agent runs are common use cases.
 *
 * Pass `debug: true` to keep error logs visible when troubleshooting.
 */
export async function withSilencedErrors<T>(
  fn: () => Promise<T>,
  options: { debug?: boolean } = {},
): Promise<T> {
  if (options.debug) return fn();
  const original = console.error;
  console.error = () => undefined;
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}
