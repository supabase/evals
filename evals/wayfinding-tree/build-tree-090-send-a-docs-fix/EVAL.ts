import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['contributing'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
