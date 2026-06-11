/**
 * Invoke a scorer with `console.error` suppressed.
 *
 * Scorers routinely trigger supabase-js operations that are *expected* to fail
 * (e.g. a cross-user write blocked by RLS). supabase-js logs those failures via
 * `console.error` even though the scorer handles them as values, producing noise
 * that buries real output. We silence `console.error` for the duration of the
 * scorer call so this is handled framework-wide rather than re-implemented in
 * each eval.
 *
 * Pass `debug: true` to keep error logs visible when troubleshooting a scorer.
 */
export async function runScorer<T>(
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
