import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = [
  'guides/functions/function-configuration',
  'guides/functions/auth',
  'guides/functions/auth-headers',
];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
