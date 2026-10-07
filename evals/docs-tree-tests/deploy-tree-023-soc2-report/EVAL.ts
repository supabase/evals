import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/security/soc-2-compliance'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
