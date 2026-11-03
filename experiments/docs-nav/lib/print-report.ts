import { collectResultFiles } from '../../../apps/framework/lib/result-files.js';
import {
  GROUNDED_CHECK,
  REACHED_TARGET_CHECK,
} from '../../../evals/docs-nav/lib/navigation.js';
import {
  type ArmRuns,
  buildReport,
} from '../../../evals/docs-nav/lib/report.js';

const ARMS: Record<string, string> = {
  'claude-code-sonnet-5-5-docs-nav': 'control',
  'claude-code-sonnet-5-5-docs-nav-option-1': 'option-1',
};

const arms: Record<string, ArmRuns> = {};
const files = await collectResultFiles({
  includeSuite: (suite) => suite === 'docs-nav',
  includeExperiment: (experiment) => experiment in ARMS,
});
for (const { result } of files) {
  const checks = result.checks ?? [];
  const reached = checks.find((check) => check.name === REACHED_TARGET_CHECK);
  if (!reached?.notes) continue;
  const cases = (arms[ARMS[result.experiment]] ??= {});
  cases[result.eval] = [
    ...(cases[result.eval] ?? []),
    {
      navigation: JSON.parse(reached.notes),
      grounded:
        checks.find((check) => check.name === GROUNDED_CHECK)?.passed ?? false,
    },
  ];
}

if (Object.keys(arms).length === 0) {
  console.error('No docs-nav results under results/docs-nav/.');
  process.exit(1);
}
console.log(buildReport(arms).table);
