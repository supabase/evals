import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/platform/cost-control'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
