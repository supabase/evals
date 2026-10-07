import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = [
  'guides/database/connecting-to-postgres',
  'guides/platform/ipv4-address',
];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
