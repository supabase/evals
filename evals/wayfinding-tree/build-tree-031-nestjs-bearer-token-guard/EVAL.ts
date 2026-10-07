import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['reference/server'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
