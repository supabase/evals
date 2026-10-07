import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/auth/jwts', 'guides/auth/signing-keys'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
