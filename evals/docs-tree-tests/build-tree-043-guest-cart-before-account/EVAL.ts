import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/auth/auth-anonymous'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
