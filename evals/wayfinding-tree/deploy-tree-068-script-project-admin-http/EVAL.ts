import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['reference/api/introduction'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
