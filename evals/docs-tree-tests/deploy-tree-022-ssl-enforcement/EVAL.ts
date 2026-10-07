import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/platform/ssl-enforcement'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
