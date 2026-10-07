import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = [
  'guides/deployment/shared-responsibility-model',
  'guides/platform/backups',
];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
