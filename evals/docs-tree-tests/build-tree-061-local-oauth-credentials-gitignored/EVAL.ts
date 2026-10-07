import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/local-development/managing-config'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
