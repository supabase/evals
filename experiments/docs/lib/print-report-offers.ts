import { collectResultFiles } from '../../../apps/framework/lib/result-files.js';
import { REPORT_EVAL_PREFIX } from '../../../evals/docs/lib/report-scoring.js';

const files = await collectResultFiles({
  includeSuite: (suite) => suite === 'docs',
  includeExperiment: (name) => name.startsWith('codex-gpt-6-luna-docs-report-'),
  includeEval: (evalId) => evalId.startsWith(REPORT_EVAL_PREFIX),
});
if (files.length === 0) {
  console.error('No docs report results under results/docs/.');
  process.exit(1);
}

const groups = new Map<string, typeof files>();
for (const file of files) {
  const key = `${file.result.experiment} ${file.result.eval}`;
  groups.set(key, [...(groups.get(key) ?? []), file]);
}
for (const runs of groups.values()) {
  const counts: Record<string, number> = {};
  for (const { result } of runs) {
    for (const check of result.checks ?? []) {
      counts[check.name] = (counts[check.name] ?? 0) + (check.passed ? 1 : 0);
    }
  }
  const { experiment, eval: evalId } = runs[0].result;
  const passed = runs.filter(({ result }) => result.passed).length;
  console.log(
    JSON.stringify({
      experiment,
      eval: evalId,
      runs: runs.length,
      passed,
      ...counts,
    })
  );
}
