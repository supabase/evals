import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/platform/database-size'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
