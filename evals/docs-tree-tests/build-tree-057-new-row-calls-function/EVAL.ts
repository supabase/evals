import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/database/webhooks'];
export const ALTERNATES = ['guides/database/extensions/pg_net'];

export default treeTestScorer(TARGETS, ALTERNATES);
