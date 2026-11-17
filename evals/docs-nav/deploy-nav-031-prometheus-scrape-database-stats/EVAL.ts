import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'set-aside';

export const TARGETS = [
  'guides/observability/metrics/vendor-agnostic',
  'guides/observability/metrics/grafana-self-hosted',
];

export default docsNavScorer(TARGETS, import.meta.url, { group: GROUP });
