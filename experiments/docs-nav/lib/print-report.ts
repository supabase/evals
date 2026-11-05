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
  'claude-code-sonnet-5.5-docs-nav': 'control',
  'claude-code-sonnet-5.5-docs-nav-option-1': 'option-1',
  'claude-code-sonnet-5.5-docs-nav-tree': 'control tree',
  'claude-code-sonnet-5.5-docs-nav-option-1-tree': 'option-1 tree',
  'claude-code-sonnet-5.5-docs-nav-option-1-tree-subheads':
    'option-1 tree subheads',
  'claude-code-sonnet-5.5-docs-nav-tree-2': 'control tree 2 levels',
  'claude-code-sonnet-5.5-docs-nav-option-1-tree-2': 'option-1 tree 2 levels',
  'claude-code-sonnet-5.5-docs-nav-option-1-tree-2-subheads':
    'option-1 tree 2 levels subheads',
  'claude-code-sonnet-5.5-docs-nav-option-1-tree-revised':
    'option-1 tree revised',
  'claude-code-sonnet-5.5-docs-nav-option-1-tree-2-revised':
    'option-1 tree 2 levels revised',
};

const arms: Record<string, ArmRuns> = Object.fromEntries(
  Object.values(ARMS).map((arm) => [arm, {}])
);
const files = await collectResultFiles({
  includeSuite: (suite) => suite === 'docs-nav',
  includeExperiment: (experiment) => experiment in ARMS,
});
for (const { result } of files) {
  const checks = result.checks ?? [];
  const reached = checks.find((check) => check.name === REACHED_TARGET_CHECK);
  if (!reached?.notes) continue;
  const cases = arms[ARMS[result.experiment]];
  cases[result.eval] = [
    ...(cases[result.eval] ?? []),
    {
      navigation: JSON.parse(reached.notes),
      grounded:
        checks.find((check) => check.name === GROUNDED_CHECK)?.passed ?? null,
    },
  ];
}

if (files.length === 0) {
  console.error('No docs-nav results under results/docs-nav/.');
  process.exit(1);
}
console.log(buildReport(arms).table);
