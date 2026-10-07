import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = [
  'guides/deployment/branching',
  'guides/deployment/branching/github-integration',
];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
