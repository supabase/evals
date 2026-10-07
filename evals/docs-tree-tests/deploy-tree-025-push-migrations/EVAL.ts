import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/deployment/database-migrations'];
export const ALTERNATES = [
  'guides/local-development/database-migrations',
  'guides/local-development/cli-workflows',
  'guides/deployment/managing-environments',
];

export default treeTestScorer(TARGETS, ALTERNATES);
