import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = [
  'guides/realtime/subscribing-to-database-changes',
  'guides/realtime/broadcast',
];
export const ALTERNATES = ['guides/realtime/getting_started'];

export default treeTestScorer(TARGETS, ALTERNATES);
