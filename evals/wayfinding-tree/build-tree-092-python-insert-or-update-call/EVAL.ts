import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['reference/python'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
