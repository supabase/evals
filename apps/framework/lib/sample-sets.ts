type SampleRow = { experiment: string; eval: string; run?: number };

export type IncompleteSampleSet = { key: string; runs: number };

/**
 * Groups `rows` (one per `result.json`) by experiment+eval and separates the
 * groups that don't contain exactly runs 1 through `expectedRuns`, so the
 * exporter never averages an incomplete or mismatched sample set.
 */
export function splitBySampleSetCompleteness<T extends SampleRow>(
  rows: readonly T[],
  expectedRuns: number
): { complete: T[]; incomplete: IncompleteSampleSet[] } {
  const sampleSets = new Map<string, { runs: number; indexes: Set<number> }>();
  for (const row of rows) {
    const key = `${row.experiment}::${row.eval}`;
    let sampleSet = sampleSets.get(key);
    if (!sampleSet) {
      sampleSet = { runs: 0, indexes: new Set() };
      sampleSets.set(key, sampleSet);
    }
    sampleSet.runs += 1;
    if (row.run !== undefined) sampleSet.indexes.add(row.run);
  }

  const incomplete: IncompleteSampleSet[] = [];
  for (const [key, { runs, indexes }] of sampleSets) {
    let hasEveryExpectedRun = indexes.size === expectedRuns;
    for (let run = 1; run <= expectedRuns && hasEveryExpectedRun; run += 1) {
      hasEveryExpectedRun = indexes.has(run);
    }
    if (runs !== expectedRuns || !hasEveryExpectedRun) {
      incomplete.push({ key, runs });
    }
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
