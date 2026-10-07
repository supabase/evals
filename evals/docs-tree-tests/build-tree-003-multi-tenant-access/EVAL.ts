import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/database/postgres/row-level-security'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
