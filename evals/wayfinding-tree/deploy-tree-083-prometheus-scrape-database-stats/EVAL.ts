import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = [
  'guides/observability/metrics/vendor-agnostic',
  'guides/observability/metrics/grafana-self-hosted',
];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
