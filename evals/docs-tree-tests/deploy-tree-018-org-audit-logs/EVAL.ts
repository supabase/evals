import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/security/platform-audit-logs'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
