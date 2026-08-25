type SampleRow = { experiment: string; eval: string };

export type IncompleteSampleSet = { key: string; runs: number };

/**
 * Groups `rows` (one per `result.json`) by experiment+eval and separates the
 * groups that don't have exactly `expectedRuns` rows, so exporter can drop
 * those instead of averaging an experiment/eval over fewer samples.
 */
export function splitBySampleSetCompleteness<T extends SampleRow>(
  rows: readonly T[],
  expectedRuns: number
): { complete: T[]; incomplete: IncompleteSampleSet[] } {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.experiment}::${row.eval}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const incomplete: IncompleteSampleSet[] = [];
  for (const [key, runs] of counts) {
    if (runs !== expectedRuns) incomplete.push({ key, runs });
  }
  incomplete.sort((a, b) => a.key.localeCompare(b.key));

  const dropped = new Set(incomplete.map(({ key }) => key));
  return {
    complete: rows.filter(
      (row) => !dropped.has(`${row.experiment}::${row.eval}`)
    ),
    incomplete,
  };
}

/**
 * Renders the incomplete pairs from `splitBySampleSetCompleteness` as a console
 * warning, e.g. `model-a::eval-1: 2 run(s)`.
 */
export function formatIncompleteSampleSets(
  incomplete: readonly IncompleteSampleSet[],
  expectedRuns: number
): string {
  return [
    `skipped ${incomplete.length} incomplete sample set(s) (expected ${expectedRuns} run(s) per pair):`,
    ...incomplete.map(({ key, runs }) => `  ${key}: ${runs} run(s)`),
  ].join('\n');
}
