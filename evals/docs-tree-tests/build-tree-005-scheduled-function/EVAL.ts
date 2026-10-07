import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = [
  'guides/functions/schedule-functions',
  'guides/cron/quickstart',
  'guides/cron',
];
export const ALTERNATES = ['guides/database/extensions/pg_net'];

export default treeTestScorer(TARGETS, ALTERNATES);
