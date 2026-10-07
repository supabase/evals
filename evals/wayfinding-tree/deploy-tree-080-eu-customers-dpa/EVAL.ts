import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/security/gdpr-compliance'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
