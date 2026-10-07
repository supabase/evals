import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/functions/background-tasks'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
