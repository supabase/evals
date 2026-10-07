import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = [
  'guides/local-development/testing/overview',
  'guides/database/postgres/row-level-security',
];
export const ALTERNATES = ['guides/local-development/testing/pgtap-extended'];

export default treeTestScorer(TARGETS, ALTERNATES);
