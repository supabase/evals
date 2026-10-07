import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/auth/redirect-urls'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
