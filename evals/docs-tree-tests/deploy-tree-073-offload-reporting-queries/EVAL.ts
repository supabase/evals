import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = [
  'guides/platform/read-replicas',
  'guides/platform/read-replicas/getting-started',
];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
