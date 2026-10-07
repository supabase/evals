import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/auth/auth-smtp', 'guides/auth/rate-limits'];
export const ALTERNATES = ['guides/deployment/going-into-prod'];

export default treeTestScorer(TARGETS, ALTERNATES);
