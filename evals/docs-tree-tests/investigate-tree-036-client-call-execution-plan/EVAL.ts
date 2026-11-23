import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = [
  'guides/database/debugging-performance',
  'guides/api/query-plans',
];
export const ALTERNATES = [
  'guides/database/postgres/row-level-security-performance',
];

export default treeTestScorer(TARGETS, ALTERNATES);
