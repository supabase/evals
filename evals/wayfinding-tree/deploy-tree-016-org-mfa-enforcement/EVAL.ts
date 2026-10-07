import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/platform/mfa/org-mfa-enforcement'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
