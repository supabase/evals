import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = [
  'guides/getting-started/api-keys',
  'guides/security/rotate-leaked-api-keys',
];
export const ALTERNATES = ['guides/getting-started/migrating-to-new-api-keys'];

export default treeTestScorer(TARGETS, ALTERNATES);
