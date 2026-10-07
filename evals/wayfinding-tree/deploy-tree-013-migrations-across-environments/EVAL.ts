import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = [
  'guides/deployment/database-migrations',
  'guides/local-development/database-migrations',
  'guides/deployment/managing-environments',
];
export const ALTERNATES = ['guides/local-development/cli-workflows'];

export default treeTestScorer(TARGETS, ALTERNATES);
