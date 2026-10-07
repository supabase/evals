import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/self-hosting/restore-from-platform'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
