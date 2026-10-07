import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/platform/network-restrictions'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
