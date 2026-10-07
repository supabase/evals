import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = [
  'guides/deployment/terraform',
  'guides/deployment/terraform/tutorial',
];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
