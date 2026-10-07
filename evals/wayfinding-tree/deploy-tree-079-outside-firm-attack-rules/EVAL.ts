import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/security/security-testing'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
