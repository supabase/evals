import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/platform/free-project-pausing'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
