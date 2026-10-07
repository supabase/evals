import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/self-hosting/updating'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
