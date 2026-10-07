import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/local-development/seeding-your-database'];
export const ALTERNATES = [
  'guides/local-development/cli-workflows',
  'guides/local-development/database-migrations',
  'guides/deployment/database-migrations',
];

export default treeTestScorer(TARGETS, ALTERNATES);
