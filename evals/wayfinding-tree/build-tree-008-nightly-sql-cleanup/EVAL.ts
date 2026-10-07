import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/cron/quickstart', 'guides/cron'];
export const ALTERNATES = ['guides/database/extensions/pg_cron'];

export default treeTestScorer(TARGETS, ALTERNATES);
