import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['reference/cli/introduction'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
