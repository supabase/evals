import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/api/rest/generating-types'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
