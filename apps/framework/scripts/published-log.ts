/**
 * Parsing for the one-line `git log` record describing a published export's
 * newest commit. Split out of local.ts so the smoke suite can exercise the
 * merge-commit case directly: local.ts reads `origin/main`, whose history has
 * no qualifying merge today, so an end-to-end check cannot reach it.
 */

/** The `--format` string `parsePublishedLog` expects. Tab-separated on purpose. */
export const PUBLISHED_LOG_FORMAT = '--format=%H%x09%P%x09%cI';

export type PublishedLog = {
  /** Full sha of the newest commit touching the export. */
  commit: string;
  /** First parent — the mainline, i.e. the ref the scheduled run built on. */
  parent: string;
  /** Committer date, ISO 8601. */
  committedAt: string;
};

/**
 * Parse one `PUBLISHED_LOG_FORMAT` line.
 *
 * Tab-separated because `%P` expands to EVERY parent, space-separated. Splitting
 * the whole line on spaces therefore binds the second parent to `committedAt` on
 * a merge commit, and a sha where an ISO date belongs poisons the baseline sort
 * (`Date.parse` -> NaN) and prints "NaNd old" into the receipt. Path-limited log
 * simplification hides most merges, but not one that changed the export relative
 * to both parents — so this is reachable, not theoretical.
 */
export function parsePublishedLog(line: string): PublishedLog {
  const bad = (why: string): never => {
    throw new Error(
      `unparseable published log line (${why}): ${JSON.stringify(line)}`
    );
  };
  // Strip only the trailing newline. `trim()` would also eat a trailing empty
  // field's separator, turning a malformed record into a confusing field count
  // instead of a precise "committedAt is not a date".
  const fields = line.replace(/\r?\n$/, '').split('\t');
  if (fields.length !== 3)
    bad(`expected 3 tab-separated fields, got ${fields.length}`);
  const [commit, parents, committedAt] = fields;
  const isSha = (s: string) => /^[0-9a-f]{40}$/.test(s);
  if (!isSha(commit)) bad('commit is not a sha');
  if (Number.isNaN(Date.parse(committedAt))) bad('committedAt is not a date');
  // A parentless commit means the premise behind `parent` (the ref the
  // scheduled run built on) does not hold, so refuse rather than record ''.
  const list = parents === '' ? [] : parents.split(' ');
  if (!list.length) bad('commit has no parent');
  if (!list.every(isSha)) bad('parent is not a sha');
  return { commit, parent: list[0], committedAt };
}
