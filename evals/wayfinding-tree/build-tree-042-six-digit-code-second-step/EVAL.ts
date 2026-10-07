import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/auth/auth-mfa/totp', 'guides/auth/auth-mfa'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
