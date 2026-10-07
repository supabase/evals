import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/getting-started/tutorials/with-flutter'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
