import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['changelog'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
