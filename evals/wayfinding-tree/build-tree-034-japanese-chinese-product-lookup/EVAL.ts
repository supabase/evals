import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/database/extensions/pgroonga'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
