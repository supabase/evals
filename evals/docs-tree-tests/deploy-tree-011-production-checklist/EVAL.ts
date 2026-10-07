import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/deployment/going-into-prod'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
