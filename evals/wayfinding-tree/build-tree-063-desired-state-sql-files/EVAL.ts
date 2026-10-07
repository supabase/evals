import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = [
  'guides/local-development/declarative-database-schemas',
];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
