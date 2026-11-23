import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = [
  'guides/database/postgres/postgres-log-config',
  'guides/observability/log-slow-queries',
];
export const ALTERNATES = ['guides/database/custom-postgres-config'];

export default treeTestScorer(TARGETS, ALTERNATES);
