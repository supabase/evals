import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/realtime/limits'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
