import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/realtime/authorization'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
