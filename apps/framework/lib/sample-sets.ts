// Drops pairs missing runs so a partial refresh doesn't average scores across
// an uneven number of samples per pair.

type SampleRow = { experiment: string; eval: string };

export type IncompleteSampleSet = { key: string; runs: number };

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

export function formatIncompleteSampleSets(
  incomplete: readonly IncompleteSampleSet[],
  expectedRuns: number
): string {
  return [
    `skipped ${incomplete.length} incomplete sample set(s) (expected ${expectedRuns} run(s) per pair):`,
    ...incomplete.map(({ key, runs }) => `  ${key}: ${runs} run(s)`),
  ].join('\n');
}
