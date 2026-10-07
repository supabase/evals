import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/platform/custom-domains'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
