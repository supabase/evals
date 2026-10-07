import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/functions/cors'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
