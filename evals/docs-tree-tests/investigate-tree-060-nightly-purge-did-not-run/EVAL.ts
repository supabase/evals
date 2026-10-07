import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/cron/quickstart'];
export const ALTERNATES = ['guides/cron'];

export default treeTestScorer(TARGETS, ALTERNATES);
