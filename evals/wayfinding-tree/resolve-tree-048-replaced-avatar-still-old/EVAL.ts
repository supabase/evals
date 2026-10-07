import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = [
  'guides/storage/cdn/smart-cdn',
  'guides/storage/cdn/purge-cdn-cache',
];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
